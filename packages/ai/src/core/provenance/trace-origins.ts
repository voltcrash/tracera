import {
  provenanceGraphSchema,
  type ClaimV2,
  type CoreIssue,
  type DocumentSnapshot,
  type EvidenceAssessment,
  type ProvenanceGraph,
  type StageResult,
} from "@repo/contracts/core-v2";
import { createAssessEvidenceV2 } from "../evidence/index";
import type { RunEnvironment, TraceOriginsV2, TraceOriginsV2Data } from "../types";
import {
  archiveAssertion,
  classifyNode,
  detectChronologyConflicts,
  detectCycles,
  hasValidatedClaim,
  rankRoots,
  searchedDateRange,
} from "./chronology";
import { extractProvenanceReferences } from "./references";
import { createProvenanceRetrievalController } from "./retrieval-controller";
import type { ArchiveCaptureCandidate, ProvenanceOptions, ProvenanceReference } from "./types";

export const traceOriginsV2: TraceOriginsV2 = createTraceOriginsV2();

export function createTraceOriginsV2(options: ProvenanceOptions = {}): TraceOriginsV2 {
  return async (input, environment) => trace(input, environment, options);
}

async function trace(
  input: Parameters<TraceOriginsV2>[0],
  environment: RunEnvironment,
  options: ProvenanceOptions,
): Promise<StageResult<TraceOriginsV2Data>> {
  const startedAt = environment.ports.clock.now();
  const startedMs = environment.ports.clock.monotonicMs();
  const issues: CoreIssue[] = [];
  const graphs: ProvenanceGraph[] = [];
  const newSnapshotIds = new Set<string>();
  const retrieval =
    options.retrieval ?? createProvenanceRetrievalController(options.retrievalOptions);
  let externalRequests = options.priorExternalRequests ?? 0;
  let totalCostUsd =
    externalRequests === 0 ? (options.priorCostUsd ?? 0) : (options.priorCostUsd ?? null);
  let stageCostUsd: number | null = 0;
  await audit("stage_started", "Claim-level provenance tracing started.", null, null);

  if (canceled(environment)) return canceledResult();
  const snapshotMap = uniqueSnapshots(input.snapshots, issues);
  const claimIds = new Set<string>();
  const claims = input.claims.filter((claim) => {
    if (claimIds.has(claim.id)) {
      issues.push(
        issue("citation_validation_failed", `Duplicate claim ID rejected: ${claim.id}.`, claim.id),
      );
      return false;
    }
    claimIds.add(claim.id);
    return (
      claim.duplicateOfClaimId === null &&
      claim.coverageDisposition === "factual_claim" &&
      claim.checkability !== "unanswerable" &&
      claim.checkability !== "not_checkable"
    );
  });

  for (const assessment of input.assessments) {
    if (!claimIds.has(assessment.claimId) || !snapshotMap.has(assessment.snapshotId)) {
      issues.push(
        issue(
          "citation_validation_failed",
          "A provenance input assessment referenced an unknown claim or snapshot and was rejected.",
          assessment.claimId,
          assessment.snapshotId,
        ),
      );
    } else if (
      assessment.validationStatus === "validated" &&
      !usableAssessment(assessment, snapshotMap)
    ) {
      issues.push(
        issue(
          "citation_validation_failed",
          "A purportedly validated provenance assessment had invalid excerpt or dependence locators and was rejected.",
          assessment.claimId,
          assessment.snapshotId,
        ),
      );
    }
  }

  for (const claim of claims) {
    if (canceled(environment)) return canceledResult();
    const graph = await traceClaim(claim);
    const parsed = provenanceGraphSchema.safeParse(graph);
    if (!parsed.success) {
      issues.push(
        issue(
          "citation_validation_failed",
          `The provenance graph failed frozen reference validation: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
          claim.id,
        ),
      );
      continue;
    }
    graphs.push(parsed.data);
  }

  const data = { graphs, newSnapshotIds: [...newSnapshotIds].sort() };
  const status =
    graphs.length < claims.length ||
    graphs.some(({ coverageStatus }) => coverageStatus !== "complete") ||
    issues.some(({ severity }) => severity !== "info")
      ? "partial"
      : "complete";
  await audit(
    "stage_finished",
    `Claim-level provenance tracing finished with status ${status}.`,
    null,
    null,
  );
  return finish(status, data);

  async function traceClaim(claim: ClaimV2): Promise<ProvenanceGraph> {
    const claimAssessments = input.assessments.filter(
      (assessment) => assessment.claimId === claim.id && usableAssessment(assessment, snapshotMap),
    );
    const workingAssessments = [...claimAssessments];
    const nodes = new Map<string, ProvenanceGraph["nodes"][number]>();
    const edges: ProvenanceGraph["edges"] = [];
    const searchLog: ProvenanceGraph["searchLog"] = [];
    const inaccessibleOriginals: ProvenanceGraph["inaccessibleOriginals"] = [];
    const queued: Array<{ snapshotId: string; hop: number }> = [];
    const traversed = new Set<string>();
    const archived = new Set<string>();
    let hopsUsed = 0;
    let incomplete = claimAssessments.length === 0;

    if (claimAssessments.length === 0) {
      issues.push(
        issue(
          "missing_evidence",
          "No validated claim-level assessment was available for provenance tracing.",
          claim.id,
        ),
      );
    }

    for (const assessment of claimAssessments) {
      const snapshot = snapshotMap.get(assessment.snapshotId);
      if (snapshot === undefined) continue;
      addNode(snapshot);
    }
    for (const node of nodes.values()) {
      if (node.claimPresentInContent) queued.push({ snapshotId: node.snapshotId, hop: 0 });
    }

    while (queued.length > 0) {
      if (canceled(environment)) break;
      const current = queued.shift()!;
      const source = snapshotMap.get(current.snapshotId);
      if (source === undefined || current.hop >= maxHops(environment)) continue;
      const traversalKey = `${source.id}\0${current.hop}`;
      if (traversed.has(traversalKey)) continue;
      traversed.add(traversalKey);

      for (const reference of extractProvenanceReferences(source)) {
        if (canceled(environment)) break;
        const target = findSnapshotByUrl(snapshotMap.values(), reference.url);
        if (target !== undefined) {
          if (
            !input.assessments.some(
              (assessment) =>
                assessment.claimId === claim.id && assessment.snapshotId === target.id,
            )
          ) {
            const assessed = await assessSnapshot(claim, target);
            workingAssessments.push(...assessed);
          }
          addNode(target);
          addEdge(source.id, target.id, reference.type, reference.locator);
          hopsUsed = Math.max(hopsUsed, current.hop + 1);
          if (nodes.get(target.id)?.claimPresentInContent)
            queued.push({ snapshotId: target.id, hop: current.hop + 1 });
          continue;
        }
        const acquired = await retrieveReference(claim, source, reference, current.hop + 1);
        if (acquired.length === 0) {
          incomplete = true;
          inaccessibleOriginals.push({ url: reference.url, reason: "content_unavailable" });
          continue;
        }
        for (const snapshot of acquired) {
          const assessed = await assessSnapshot(claim, snapshot);
          workingAssessments.push(...assessed);
          addNode(snapshot);
          addEdge(source.id, snapshot.id, reference.type, reference.locator);
          newSnapshotIds.add(snapshot.id);
          hopsUsed = Math.max(hopsUsed, current.hop + 1);
          if (nodes.get(snapshot.id)?.claimPresentInContent)
            queued.push({ snapshotId: snapshot.id, hop: current.hop + 1 });
        }
      }

      if (
        options.archive !== undefined &&
        source.originalUrl !== null &&
        !archived.has(source.id)
      ) {
        archived.add(source.id);
        const captures = await lookupArchive(claim, source);
        for (const capture of captures) {
          const reference = archiveReference(source, capture);
          const acquired = await retrieveReference(claim, source, reference, current.hop + 1);
          if (acquired.length === 0) {
            incomplete = true;
            inaccessibleOriginals.push({ url: capture.captureUrl, reason: "content_unavailable" });
            continue;
          }
          for (const snapshot of acquired) {
            const assessed = await assessSnapshot(claim, snapshot);
            workingAssessments.push(...assessed);
            addNode(snapshot, archiveAssertion(capture.observedAt), "archive_capture");
            const locator = locateExact(snapshot, capture.originalUrl);
            if (locator === null) {
              incomplete = true;
              issues.push(
                issue(
                  "citation_validation_failed",
                  "An archive capture did not contain a locator tying it to the claimed original URL.",
                  claim.id,
                  snapshot.id,
                  capture.captureUrl,
                ),
              );
            } else {
              addEdge(snapshot.id, source.id, "archives", locator);
            }
            newSnapshotIds.add(snapshot.id);
            hopsUsed = Math.max(hopsUsed, current.hop + 1);
          }
        }
      }
    }

    const nodeList = [...nodes.values()];
    const cycles = detectCycles(nodeList, edges);
    const chronologyConflicts = detectChronologyConflicts(nodeList, edges);
    if (chronologyConflicts.length > 0 || cycles.length > 0) incomplete = true;
    const graph: ProvenanceGraph = {
      claimId: claim.id,
      nodes: nodeList,
      edges: deduplicateEdges(edges),
      candidateRoots: rankRoots(nodeList, workingAssessments, [...snapshotMap.values()]),
      searchLog,
      searchedDateRange: searchedDateRange(nodeList, environment.context.asOfTime),
      hopsUsed,
      chronologyConflicts,
      cycles,
      inaccessibleOriginals: deduplicateUnavailable(inaccessibleOriginals),
      coverageStatus: incomplete ? "partial" : "complete",
      globalOriginClaimed: false,
    };
    return graph;

    function addNode(
      snapshot: DocumentSnapshot,
      extraTimestamp?: ProvenanceGraph["nodes"][number]["timestamps"][number],
      forcedRole?: ProvenanceGraph["nodes"][number]["role"],
    ) {
      const assessments = workingAssessments.filter(({ snapshotId }) => snapshotId === snapshot.id);
      const existing = nodes.get(snapshot.id);
      const timestamps = deduplicateTimestamps([
        ...snapshot.timestampAssertions,
        ...(existing?.timestamps ?? []),
        ...(extraTimestamp === undefined ? [] : [extraTimestamp]),
      ]);
      nodes.set(snapshot.id, {
        snapshotId: snapshot.id,
        role: forcedRole ?? classifyNode(snapshot, assessments),
        url: snapshot.canonicalUrl ?? snapshot.finalUrl ?? snapshot.originalUrl,
        timestamps,
        claimPresentInContent: hasValidatedClaim(assessments),
      });
    }

    function addEdge(
      fromSnapshotId: string,
      toSnapshotId: string,
      type: ProvenanceGraph["edges"][number]["type"],
      locator: ProvenanceReference["locator"],
    ) {
      edges.push({ fromSnapshotId, toSnapshotId, type, supportingLocators: [locator] });
    }

    async function retrieveReference(
      scopedClaim: ClaimV2,
      sourceSnapshot: DocumentSnapshot,
      reference: ProvenanceReference,
      hop: number,
    ) {
      if (hop > maxHops(environment) || budgetBlocked(2)) {
        incomplete = true;
        searchLog.push(
          log(
            reference.url,
            "provenance-budget",
            0,
            "budget_exhausted",
            environment.ports.clock.now(),
          ),
        );
        issues.push(
          issue(
            "budget_exhausted",
            "Provenance traversal exhausted the shared request cap.",
            scopedClaim.id,
          ),
        );
        return [];
      }
      const result = await retrieval.retrieveReference(
        {
          claim: scopedClaim,
          sourceSnapshot,
          snapshots: [...snapshotMap.values()],
          reference,
          hop,
          priorExternalRequests: externalRequests,
          priorCostUsd: totalCostUsd,
        },
        environment,
      );
      externalRequests += result.metrics.externalRequests;
      totalCostUsd = addCost(totalCostUsd, result.metrics.costUsd);
      stageCostUsd = addCost(stageCostUsd, result.metrics.costUsd);
      issues.push(...result.issues);
      const matching = (result.data?.snapshots ?? []).filter((snapshot) =>
        sameUrl(snapshot, reference.url),
      );
      for (const snapshot of matching) snapshotMap.set(snapshot.id, snapshot);
      const outcome =
        result.data === null
          ? result.issues.some(({ code }) => code === "budget_exhausted")
            ? "budget_exhausted"
            : "outage"
          : matching.length > 0
            ? "results"
            : "no_results";
      const providers = [...new Set(result.data?.candidates.map(({ provider }) => provider) ?? [])];
      for (const provider of providers.length > 0 ? providers : ["retrieval-controller"]) {
        searchLog.push(
          log(reference.url, provider, matching.length, outcome, environment.ports.clock.now()),
        );
      }
      if ((result.data?.snapshots.length ?? 0) !== matching.length) {
        issues.push(
          issue(
            "citation_validation_failed",
            "A provenance retrieval result did not match the explicit referenced URL and was rejected.",
            scopedClaim.id,
          ),
        );
      }
      return matching;
    }

    async function assessSnapshot(scopedClaim: ClaimV2, snapshot: DocumentSnapshot) {
      if (budgetBlocked(1)) {
        incomplete = true;
        issues.push(
          issue(
            "budget_exhausted",
            "A newly acquired provenance snapshot could not be assessed within the shared request cap.",
            scopedClaim.id,
            snapshot.id,
          ),
        );
        return [];
      }
      const assessEvidence =
        options.assessEvidence ??
        createAssessEvidenceV2({
          maxGenerationRequests: Math.max(
            0,
            environment.context.budget.maxExternalRequests - externalRequests,
          ),
        });
      const result = await assessEvidence(
        { claims: [scopedClaim], snapshots: [snapshot], admittedSnapshotIds: [snapshot.id] },
        environment,
      );
      externalRequests += result.metrics.externalRequests;
      totalCostUsd = addCost(totalCostUsd, result.metrics.costUsd);
      stageCostUsd = addCost(stageCostUsd, result.metrics.costUsd);
      issues.push(...result.issues);
      await audit(
        "external_request",
        `New provenance snapshot returned through evidence assessment with status ${result.status}.`,
        scopedClaim.id,
        snapshot.id,
      );
      if (result.data === null) incomplete = true;
      return result.data?.assessments ?? [];
    }

    async function lookupArchive(scopedClaim: ClaimV2, snapshot: DocumentSnapshot) {
      if (options.archive === undefined || snapshot.originalUrl === null) return [];
      if (budgetBlocked(3)) {
        incomplete = true;
        searchLog.push(
          log(
            `archive:${snapshot.originalUrl}`,
            options.archive.provider,
            0,
            "budget_exhausted",
            environment.ports.clock.now(),
          ),
        );
        return [];
      }
      externalRequests += 1;
      const result = await options.archive.lookup({
        claimId: scopedClaim.id,
        url: snapshot.originalUrl,
        asOfTime: environment.context.asOfTime,
        signal: environment.signal,
      });
      totalCostUsd = addCost(totalCostUsd, result.metrics.costUsd);
      stageCostUsd = addCost(stageCostUsd, result.metrics.costUsd);
      issues.push(...result.issues);
      const outcome =
        result.data === null
          ? result.issues.some(({ code }) => code === "capability_unavailable")
            ? "unsupported"
            : "outage"
          : result.data.captures.length === 0
            ? "no_results"
            : "results";
      searchLog.push(
        log(
          `archive:${snapshot.originalUrl}`,
          options.archive.provider,
          result.data?.captures.length ?? 0,
          outcome,
          environment.ports.clock.now(),
        ),
      );
      if (result.data === null) incomplete = true;
      const captures = result.data?.captures ?? [];
      const matching = captures.filter(
        ({ originalUrl }) => normalizeUrl(originalUrl) === normalizeUrl(snapshot.originalUrl!),
      );
      if (matching.length !== captures.length) {
        incomplete = true;
        issues.push(
          issue(
            "citation_validation_failed",
            "An archive lookup returned a capture for a different original URL and was rejected.",
            scopedClaim.id,
            snapshot.id,
            snapshot.originalUrl,
          ),
        );
      }
      return matching;
    }
  }

  async function canceledResult(): Promise<StageResult<TraceOriginsV2Data>> {
    issues.push(issue("cancellation_requested", "Provenance tracing was canceled."));
    await audit(
      "cancellation",
      "Provenance tracing canceled; no partial graph was returned.",
      null,
      null,
    );
    return finish("failed", null);
  }

  function finish(
    status: StageResult<TraceOriginsV2Data>["status"],
    data: TraceOriginsV2Data | null,
  ): StageResult<TraceOriginsV2Data> {
    return {
      status,
      data,
      issues,
      metrics: {
        startedAt,
        completedAt: environment.ports.clock.now(),
        durationMs: Math.max(0, environment.ports.clock.monotonicMs() - startedMs),
        externalRequests: Math.max(0, externalRequests - (options.priorExternalRequests ?? 0)),
        inputTokens: null,
        outputTokens: null,
        costUsd: stageCostUsd,
      },
    } as StageResult<TraceOriginsV2Data>;
  }

  function audit(
    kind:
      | "stage_started"
      | "stage_finished"
      | "external_request"
      | "validation_rejected"
      | "cancellation",
    message: string,
    claimId: string | null,
    snapshotId: string | null,
  ) {
    return environment.ports.audit.record({
      runId: environment.context.runId,
      stage: "trace_origins",
      kind,
      message,
      claimId,
      snapshotId,
      at: environment.ports.clock.now(),
    });
  }

  function budgetBlocked(reservedRequests: number) {
    if (externalRequests + reservedRequests > environment.context.budget.maxExternalRequests) {
      return true;
    }
    const maximumCost = environment.context.budget.maxCostUsd;
    return maximumCost !== null && (totalCostUsd === null || totalCostUsd > maximumCost);
  }
}

function uniqueSnapshots(snapshots: DocumentSnapshot[], issues: CoreIssue[]) {
  const result = new Map<string, DocumentSnapshot>();
  for (const snapshot of snapshots) {
    const existing = result.get(snapshot.id);
    if (existing !== undefined && existing.contentHash !== snapshot.contentHash) {
      issues.push(
        issue(
          "citation_validation_failed",
          `Conflicting immutable snapshot ID rejected: ${snapshot.id}.`,
          null,
          snapshot.id,
        ),
      );
      continue;
    }
    result.set(snapshot.id, snapshot);
  }
  return result;
}

function usableAssessment(
  assessment: EvidenceAssessment,
  snapshots: Map<string, DocumentSnapshot>,
) {
  if (assessment.validationStatus !== "validated") return false;
  const snapshot = snapshots.get(assessment.snapshotId);
  if (
    snapshot === undefined ||
    snapshot.normalizedText.slice(assessment.excerpt.span.start, assessment.excerpt.span.end) !==
      assessment.excerpt.quote
  ) {
    return false;
  }
  return assessment.dependenceLocators.every((locator) => {
    const locatedSnapshot = snapshots.get(locator.snapshotId);
    return (
      locatedSnapshot !== undefined &&
      locatedSnapshot.normalizedText.slice(locator.span.start, locator.span.end) === locator.quote
    );
  });
}

function findSnapshotByUrl(snapshots: Iterable<DocumentSnapshot>, target: string) {
  for (const snapshot of snapshots) if (sameUrl(snapshot, target)) return snapshot;
  return undefined;
}

function sameUrl(snapshot: DocumentSnapshot, target: string) {
  const normalized = normalizeUrl(target);
  return [snapshot.originalUrl, snapshot.finalUrl, snapshot.canonicalUrl].some(
    (url) => url !== null && normalizeUrl(url) === normalized,
  );
}

function normalizeUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function archiveReference(
  source: DocumentSnapshot,
  capture: ArchiveCaptureCandidate,
): ProvenanceReference {
  const url = source.originalUrl!;
  const located = locateExact(source, url);
  return {
    url: capture.captureUrl,
    type: "cites",
    locator: located ?? firstLocator(source),
  };
}

function locateExact(
  snapshot: DocumentSnapshot,
  quote: string,
): ProvenanceReference["locator"] | null {
  const start = snapshot.normalizedText.indexOf(quote);
  if (start < 0) return null;
  return { snapshotId: snapshot.id, span: { start, end: start + quote.length }, quote };
}

function firstLocator(snapshot: DocumentSnapshot): ProvenanceReference["locator"] {
  const locator = snapshot.locators.find(({ span }) => span.start < span.end);
  const span = locator?.span ?? { start: 0, end: snapshot.normalizedText.length };
  const quote = snapshot.normalizedText.slice(span.start, span.end);
  return { snapshotId: snapshot.id, span, quote };
}

function deduplicateEdges(edges: ProvenanceGraph["edges"]) {
  return [
    ...new Map(
      edges.map((edge) => [`${edge.fromSnapshotId}\0${edge.toSnapshotId}\0${edge.type}`, edge]),
    ).values(),
  ];
}

function deduplicateUnavailable(values: ProvenanceGraph["inaccessibleOriginals"]) {
  return [...new Map(values.map((value) => [value.url, value])).values()];
}

function deduplicateTimestamps(values: ProvenanceGraph["nodes"][number]["timestamps"]) {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
}

function maxHops(environment: RunEnvironment) {
  return Math.min(3, environment.context.budget.maxProvenanceHops);
}

function log(
  query: string,
  provider: string,
  resultCount: number,
  outcome: ProvenanceGraph["searchLog"][number]["outcome"],
  executedAt: string,
): ProvenanceGraph["searchLog"][number] {
  return { query, provider, executedAt, resultCount, outcome };
}

function addCost(current: number | null, added: number | null) {
  return current === null || added === null ? null : current + added;
}

function canceled(environment: RunEnvironment) {
  return environment.signal.aborted || environment.context.cancellation.requested;
}

function issue(
  code: CoreIssue["code"],
  message: string,
  claimId: string | null = null,
  snapshotId: string | null = null,
  url: string | null = null,
): CoreIssue {
  return { code, severity: "warning", message, claimId, snapshotId, url };
}
