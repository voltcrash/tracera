import {
  documentSnapshotSchema,
  evidenceCandidateSchema,
  type Claim,
  type AnalysisIssue,
  type DocumentSnapshot,
  type EvidenceCandidate,
  type StageResult,
} from "@repo/contracts/analysis";
import type {
  RetrieveEvidence,
  RetrieveEvidenceData,
  RetrieveEvidenceInput,
  RunEnvironment,
} from "../types";
import { selectPassageCandidates } from "./passages";
import { buildPropositionKey, buildRetrievalQuestions } from "./questions";
import type { AcquiredEvidence, RetrievalOptions, RetrievalQuestion } from "./types";

const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_PASSAGES_PER_SNAPSHOT = 8;
const DEFAULT_PASSAGE_POOL_PER_CLAIM = 40;

export const retrieveEvidence: RetrieveEvidence = createRetrieveEvidence();

export function createRetrieveEvidence(options: RetrievalOptions = {}): RetrieveEvidence {
  return async (input, environment) => retrieve(input, environment, options);
}

async function retrieve(
  input: RetrieveEvidenceInput,
  environment: RunEnvironment,
  options: RetrievalOptions,
): Promise<StageResult<RetrieveEvidenceData>> {
  const startedAt = environment.ports.clock.now();
  const started = environment.ports.clock.monotonicMs();
  const issues: AnalysisIssue[] = [];
  const audit = createAudit(environment);
  let budget: ReturnType<typeof createBudget> | null = null;
  await audit("stage_started", "Evidence retrieval started.", null, null);

  if (isCanceled(environment)) {
    await audit("cancellation", "Evidence retrieval canceled before discovery.", null, null);
    return finish("failed", null, [issue("cancellation_requested", "Retrieval was canceled.")]);
  }

  const maxRounds = environment.context.budget.maxTargetedRetrievalRounds;
  if (input.round < 0 || input.round > maxRounds || input.round > 2) {
    return finish("failed", null, [
      issue(
        "budget_exhausted",
        `Retrieval round ${input.round} exceeds the allowed targeted rounds.`,
      ),
    ]);
  }

  const claims = eligibleClaims(input, issues);
  if (claims.length === 0) {
    const data = emptyData("no_results");
    await audit("stage_finished", "No canonical factual claims required retrieval.", null, null);
    return finish("complete", data, issues);
  }

  const searchPorts = options.searchPorts ?? environment.ports.search;
  if (searchPorts.length === 0 && options.corpus === undefined) {
    const unavailable = issue(
      "capability_unavailable",
      "No generic web search or tenant-scoped corpus capability is available.",
    );
    await audit("stage_finished", unavailable.message, null, null);
    return finish("unavailable", null, [...issues, unavailable]);
  }

  budget = createBudget(environment, options);
  const candidates: EvidenceCandidate[] = [];
  const acquired: AcquiredEvidence[] = [];
  let searchAttempts = 0;
  let successfulSearches = 0;
  let outages = 0;
  let omitted = false;
  let exhausted = false;

  if (searchPorts.length === 0) {
    issues.push(
      issue(
        "capability_unavailable",
        "Generic web search is unavailable; retrieval is limited to the tenant-scoped corpus.",
        "info",
      ),
    );
  }

  if (options.primarySourceResolver === undefined) {
    issues.push(
      issue(
        "capability_unavailable",
        "A dedicated primary-source resolver is unavailable; primary-source web queries remain enabled.",
        "info",
      ),
    );
  }

  for (const [claimIndex, claim] of claims.entries()) {
    if (isCanceled(environment)) return canceledResult();
    await retrieveCorpus(claim);

    const feedback = input.sufficiency.find((item) => item.claimId === claim.id) ?? null;
    const questions = prioritizeQuestions(
      buildRetrievalQuestions(claim, input.round, feedback),
    ).slice(0, environment.context.budget.maxDiscoveryQueriesPerClaim);
    if (questions.length === 0) continue;

    const laterClaimReserve = Math.max(0, claims.length - claimIndex - 1) * 2;
    const reservedFetch = 1 + laterClaimReserve;
    for (const question of questions) {
      if (!budget.canSpend(1, reservedFetch)) {
        omitted = true;
        exhausted = true;
        await audit(
          "budget_consumed",
          `Omitted query ${question.intent} for ${claim.id}; acquisition capacity remained reserved.`,
          claim.id,
          null,
        );
        continue;
      }
      for (const port of searchPorts) {
        if (!budget.canSpend(1, reservedFetch)) {
          omitted = true;
          exhausted = true;
          break;
        }
        if (
          question.intent === "date_constrained" &&
          question.dateRange !== null &&
          !port.supportsDateRange
        ) {
          issues.push(
            issue(
              "capability_unavailable",
              `${port.provider} does not support date-range filtering; its date-constrained call was omitted.`,
              "info",
              claim.id,
            ),
          );
          await audit(
            "external_request",
            `Unsupported date filter omitted for ${port.provider}.`,
            claim.id,
            null,
          );
          continue;
        }
        searchAttempts += 1;
        budget.spend(1);
        await audit(
          "external_request",
          `Discovery query sent to ${port.provider}: ${question.intent}; transformations=${question.transformations.length}.`,
          claim.id,
          null,
        );
        const result = await port.search({
          query: question.query,
          intent: question.intent,
          claimId: claim.id,
          limit: environment.context.budget.maxFetchedCandidatesPerClaim,
          dateRange: question.dateRange,
          signal: environment.signal,
        });
        budget.spend(Math.max(0, result.metrics.externalRequests - 1));
        budget.addCost(result.metrics.costUsd);
        if (result.status === "complete" && result.data !== null) {
          successfulSearches += 1;
          const accepted = validateCandidates(
            result.data.candidates,
            claim,
            question,
            port.provider,
          );
          candidates.push(...accepted);
          for (const candidate of result.data.candidates) {
            if (accepted.some(({ id }) => id === candidate.id)) {
              await audit(
                "external_request",
                `Candidate discovered: ${candidate.proposedUrl}`,
                claim.id,
                null,
              );
            } else {
              issues.push(
                issue(
                  "citation_validation_failed",
                  "A provider candidate failed frozen candidate or request-scope validation.",
                  "warning",
                  claim.id,
                ),
              );
              await audit(
                "validation_rejected",
                `Malformed or out-of-scope candidate rejected: ${candidate.id}`,
                claim.id,
                null,
              );
            }
          }
          await audit(
            "external_request",
            `Discovery result from ${port.provider}: ${accepted.length} accepted of ${result.data.candidates.length}; costUsd=${String(result.metrics.costUsd)}.`,
            claim.id,
            null,
          );
        } else {
          outages += 1;
          issues.push(
            ...result.issues.map((value) => ({ ...value, claimId: value.claimId ?? claim.id })),
          );
          await audit(
            "external_request",
            `Discovery outage from ${port.provider}.`,
            claim.id,
            null,
          );
        }
        if (budget.costExceeded()) {
          exhausted = true;
          omitted = true;
          break;
        }
      }
    }

    if (
      options.primarySourceResolver !== undefined &&
      candidates.some((item) => item.claimId === claim.id)
    ) {
      if (budget.canSpend(1, reservedFetch)) {
        budget.spend(1);
        const resolved = await options.primarySourceResolver.resolve({
          claim,
          candidates: candidates.filter((item) => item.claimId === claim.id),
          limit: environment.context.budget.maxFetchedCandidatesPerClaim,
          signal: environment.signal,
        });
        budget.spend(Math.max(0, resolved.metrics.externalRequests - 1));
        budget.addCost(resolved.metrics.costUsd);
        if (resolved.data !== null) {
          candidates.push(
            ...resolved.data.candidates.flatMap((candidate) =>
              validateCandidates(
                [candidate],
                claim,
                {
                  claimId: claim.id,
                  question: "Resolve a primary document from discovered candidates.",
                  query: candidate.query,
                  intent: "primary_source",
                  dateRange: null,
                  transformations: [],
                },
                options.primarySourceResolver!.provider,
              ),
            ),
          );
        } else {
          issues.push(...resolved.issues);
        }
      } else {
        exhausted = true;
        omitted = true;
      }
    }

    const claimCandidates = deduplicateCandidates(
      candidates.filter((item) => item.claimId === claim.id),
    );
    const claimCandidateCount = candidates.filter((item) => item.claimId === claim.id).length;
    if (claimCandidates.length < claimCandidateCount) {
      await audit(
        "validation_rejected",
        `${claimCandidateCount - claimCandidates.length} duplicate candidate result(s) omitted.`,
        claim.id,
        null,
      );
    }
    const inputUrls = new Set(
      input.snapshots
        .filter((snapshot) => snapshot.role === "submitted_input")
        .flatMap((snapshot) => [snapshot.originalUrl, snapshot.finalUrl, snapshot.canonicalUrl])
        .filter((url): url is string => url !== null)
        .map(normalizeUrl),
    );
    let fetched = 0;
    for (const candidate of rankCandidates(claimCandidates)) {
      if (fetched >= environment.context.budget.maxFetchedCandidatesPerClaim) {
        omitted = true;
        await audit(
          "budget_consumed",
          `Candidate omitted by per-claim fetch cap: ${candidate.proposedUrl}`,
          claim.id,
          null,
        );
        continue;
      }
      if (inputUrls.has(normalizeUrl(candidate.proposedUrl))) {
        issues.push(
          issue(
            "citation_validation_failed",
            "The submitted document cannot independently corroborate itself.",
            "warning",
            claim.id,
            null,
            candidate.proposedUrl,
          ),
        );
        await audit(
          "validation_rejected",
          `Submitted-input candidate rejected: ${candidate.proposedUrl}`,
          claim.id,
          null,
        );
        continue;
      }
      if (!budget.canSpend(1, laterClaimReserve)) {
        exhausted = true;
        omitted = true;
        await audit(
          "budget_consumed",
          `Candidate fetch omitted by global budget: ${candidate.proposedUrl}`,
          claim.id,
          null,
        );
        continue;
      }
      fetched += 1;
      budget.spend(1);
      await audit(
        "external_request",
        `Fetching full candidate document: ${candidate.proposedUrl}`,
        claim.id,
        null,
      );
      const fetchedResult = await environment.ports.documents.acquire({
        url: candidate.proposedUrl,
        role: candidate.queryIntent === "primary_source" ? "primary_record" : "evidence",
        maxBytes: options.maxDocumentBytes ?? DEFAULT_MAX_BYTES,
        signal: environment.signal,
      });
      budget.spend(Math.max(0, fetchedResult.metrics.externalRequests - 1));
      budget.addCost(fetchedResult.metrics.costUsd);
      if (fetchedResult.data === null) {
        issues.push(...fetchedResult.issues);
        await audit(
          "external_request",
          `Fetch failed; candidate remains non-admissible: ${candidate.proposedUrl}`,
          claim.id,
          null,
        );
        continue;
      }
      const snapshot = documentSnapshotSchema.safeParse(fetchedResult.data.snapshot);
      if (!snapshot.success || !isFullDocument(snapshot.data, candidate)) {
        issues.push(
          issue(
            "content_unavailable",
            "Fetched content was incomplete, empty, mismatched, or truncated; the candidate remains non-admissible.",
            "warning",
            claim.id,
            snapshot.success ? snapshot.data.id : null,
            candidate.proposedUrl,
          ),
        );
        await audit(
          "validation_rejected",
          `Fetched candidate rejected before passage selection: ${candidate.proposedUrl}`,
          claim.id,
          snapshot.success ? snapshot.data.id : null,
        );
        continue;
      }
      try {
        await environment.ports.snapshots.put(snapshot.data, environment.signal);
      } catch (error) {
        issues.push(
          issue(
            "provider_failure",
            error instanceof Error ? error.message : "Snapshot persistence failed.",
            "error",
            claim.id,
            snapshot.data.id,
            candidate.proposedUrl,
          ),
        );
        await audit(
          "validation_rejected",
          `Snapshot persistence failed; candidate was not admitted: ${candidate.proposedUrl}`,
          claim.id,
          snapshot.data.id,
        );
        continue;
      }
      let passages = selectPassageCandidates(
        snapshot.data,
        claim,
        options.maxPassagesPerSnapshot ?? DEFAULT_PASSAGES_PER_SNAPSHOT,
      );
      if (options.reranker !== undefined) {
        if (budget.canSpend(1, laterClaimReserve)) {
          budget.spend(1);
          const reranked = await options.reranker.rerank({
            claim,
            passages,
            limit: options.maxPassagesPerSnapshot ?? DEFAULT_PASSAGES_PER_SNAPSHOT,
            signal: environment.signal,
          });
          budget.addCost(reranked.costUsd);
          passages = reranked.passages;
        } else {
          exhausted = true;
          omitted = true;
          issues.push(
            issue(
              "budget_exhausted",
              `Passage reranking omitted by the shared request cap: ${candidate.proposedUrl}`,
              "warning",
              claim.id,
              null,
              candidate.proposedUrl,
            ),
          );
        }
      }
      passages = passages.slice(
        0,
        options.maxPassagePoolPerClaim ?? DEFAULT_PASSAGE_POOL_PER_CLAIM,
      );
      acquired.push({ candidate, snapshot: snapshot.data, passages });
      await audit(
        "external_request",
        `Immutable document acquired; ${passages.length} passages await Task 07 assessment.`,
        claim.id,
        snapshot.data.id,
      );
    }
  }

  if (isCanceled(environment)) return canceledResult();
  if (budget.costExceeded()) {
    issues.push(
      issue(
        "budget_exhausted",
        "The configured cost ceiling was reached or could not be safely enforced.",
      ),
    );
    exhausted = true;
  }
  if (exhausted)
    issues.push(
      issue(
        "budget_exhausted",
        "The shared retrieval budget was exhausted before all planned work completed.",
      ),
    );

  const uniqueCandidates = deduplicateCandidates(candidates);
  const uniqueSnapshots = deduplicateSnapshots(acquired.map(({ snapshot }) => snapshot));
  const stoppingReason = exhausted
    ? "budget_exhausted"
    : searchAttempts > 0 && outages === searchAttempts && successfulSearches === 0
      ? "provider_outage"
      : uniqueCandidates.length === 0 && uniqueSnapshots.length === 0
        ? "no_results"
        : "plan_complete";
  if (stoppingReason === "provider_outage" && uniqueCandidates.length === 0) {
    const outage = issue("provider_outage", "Every attempted discovery provider was unavailable.");
    await audit("stage_finished", outage.message, null, null);
    return finish("unavailable", null, [...issues, outage]);
  }

  const data: RetrieveEvidenceData = {
    candidates: uniqueCandidates,
    snapshots: uniqueSnapshots,
    admittedSnapshotIds: uniqueSnapshots.map(({ id }) => id),
    budgetUsed: { externalRequests: budget.usedInStage(), costUsd: budget.totalCost() },
    stoppingReason,
  };
  const status =
    exhausted ||
    omitted ||
    issues.some(({ severity }) => severity === "warning" || severity === "error")
      ? "partial"
      : "complete";
  await audit(
    "stage_finished",
    `Evidence retrieval ${status}; stopping reason ${stoppingReason}.`,
    null,
    null,
  );
  return finish(status, data, issues);

  async function retrieveCorpus(claim: Claim) {
    if (options.corpus === undefined) return;
    const corpus = await options.corpus.find({
      tenantId: environment.context.tenantId,
      ownerUserId: environment.context.ownerUserId,
      visibility: environment.context.visibility,
      claim,
      propositionKey: buildPropositionKey(claim),
      retrieverVersion: environment.context.versions.retriever,
      limit: environment.context.budget.maxFetchedCandidatesPerClaim,
      signal: environment.signal,
    });
    if (corpus.data === null) {
      issues.push(...corpus.issues);
      return;
    }
    for (const match of corpus.data.matches) {
      const snapshot = await environment.ports.snapshots.get(match.snapshotId, environment.signal);
      if (
        snapshot === null ||
        snapshot.contentHash !== match.contentHash ||
        match.tenantId !== environment.context.tenantId ||
        match.ownerUserId !== environment.context.ownerUserId ||
        match.visibility !== environment.context.visibility ||
        match.propositionKey !== buildPropositionKey(claim) ||
        match.retrieverVersion !== environment.context.versions.retriever ||
        !temporalScopeMatches(claim, match.temporalScope) ||
        snapshot.role === "submitted_input" ||
        snapshot.extractionStatus !== "complete"
      ) {
        issues.push(
          issue(
            "citation_validation_failed",
            "A corpus proposal failed content, scope, time, version, or role revalidation.",
            "warning",
            claim.id,
            match.snapshotId,
          ),
        );
        await audit(
          "validation_rejected",
          `Corpus proposal rejected: ${match.snapshotId}; prior reasoning was not read.`,
          claim.id,
          match.snapshotId,
        );
        continue;
      }
      acquired.push({
        candidate: corpusCandidate(claim, match.snapshotId, snapshot),
        snapshot,
        passages: selectPassageCandidates(
          snapshot,
          claim,
          options.maxPassagesPerSnapshot ?? DEFAULT_PASSAGES_PER_SNAPSHOT,
        ),
      });
      await audit(
        "external_request",
        `Tenant-scoped corpus snapshot revalidated: ${match.snapshotId}.`,
        claim.id,
        match.snapshotId,
      );
    }
  }

  async function canceledResult(): Promise<StageResult<RetrieveEvidenceData>> {
    await audit(
      "cancellation",
      "Evidence retrieval canceled; no partial snapshot was admitted.",
      null,
      null,
    );
    return finish("failed", null, [issue("cancellation_requested", "Retrieval was canceled.")]);
  }

  function finish(
    status: StageResult<RetrieveEvidenceData>["status"],
    data: RetrieveEvidenceData | null,
    finalIssues: AnalysisIssue[],
  ): StageResult<RetrieveEvidenceData> {
    const completedAt = environment.ports.clock.now();
    return {
      status,
      data,
      issues: finalIssues,
      metrics: {
        startedAt,
        completedAt,
        durationMs: Math.max(0, environment.ports.clock.monotonicMs() - started),
        externalRequests: budget?.usedInStage() ?? 0,
        inputTokens: null,
        outputTokens: null,
        costUsd: budget?.totalCost() ?? 0,
      },
    };
  }
}

function eligibleClaims(input: RetrieveEvidenceInput, issues: AnalysisIssue[]) {
  const seen = new Set<string>();
  const result: Claim[] = [];
  for (const claim of input.claims) {
    if (seen.has(claim.id)) {
      issues.push(
        issue(
          "citation_validation_failed",
          `Duplicate claim ID rejected: ${claim.id}.`,
          "warning",
          claim.id,
        ),
      );
      continue;
    }
    seen.add(claim.id);
    if (claim.duplicateOfClaimId !== null || claim.coverageDisposition !== "factual_claim")
      continue;
    if (claim.checkability === "unanswerable" || claim.checkability === "not_checkable") continue;
    result.push(claim);
  }
  return result;
}

function validateCandidates(
  raw: EvidenceCandidate[],
  claim: Claim,
  question: RetrievalQuestion,
  provider: string,
) {
  return raw.flatMap((candidate) => {
    const parsed = evidenceCandidateSchema.safeParse(candidate);
    return parsed.success &&
      parsed.data.claimId === claim.id &&
      parsed.data.query === question.query &&
      parsed.data.queryIntent === question.intent &&
      parsed.data.provider === provider &&
      parsed.data.admissible === false
      ? [parsed.data]
      : [];
  });
}

function rankCandidates(candidates: EvidenceCandidate[]) {
  const priority = {
    primary_source: 0,
    disconfirming: 1,
    date_constrained: 2,
    neutral: 3,
    supporting: 4,
    origin_trace: 5,
  };
  return [...candidates].sort(
    (left, right) =>
      priority[left.queryIntent] - priority[right.queryIntent] || left.rank - right.rank,
  );
}

function prioritizeQuestions(questions: RetrievalQuestion[]) {
  const priority = {
    disconfirming: 0,
    neutral: 1,
    primary_source: 2,
    date_constrained: 3,
    supporting: 4,
    origin_trace: 5,
  };
  return [...questions].sort((left, right) => priority[left.intent] - priority[right.intent]);
}

function deduplicateCandidates(candidates: EvidenceCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.claimId}\0${normalizeUrl(candidate.proposedUrl)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateSnapshots(snapshots: DocumentSnapshot[]) {
  return [...new Map(snapshots.map((snapshot) => [snapshot.id, snapshot])).values()];
}

function isFullDocument(snapshot: DocumentSnapshot, candidate: EvidenceCandidate) {
  return (
    snapshot.extractionStatus === "complete" &&
    !snapshot.limits.truncated &&
    snapshot.normalizedText.trim() !== "" &&
    snapshot.originalUrl !== null &&
    normalizeUrl(snapshot.originalUrl) === normalizeUrl(candidate.proposedUrl)
  );
}

function temporalScopeMatches(claim: Claim, candidate: Claim["time"]["interval"]) {
  const claimStart = claim.time.interval.earliest;
  const claimEnd = claim.time.interval.latest;
  if (claimStart === null || claimEnd === null)
    return candidate.earliest === null && candidate.latest === null;
  return candidate.earliest === claimStart && candidate.latest === claimEnd;
}

function corpusCandidate(
  claim: Claim,
  snapshotId: string,
  snapshot: DocumentSnapshot,
): EvidenceCandidate {
  return {
    id: `cand_corpus_${snapshotId}`,
    claimId: claim.id,
    query: buildPropositionKey(claim),
    queryIntent: "neutral",
    provider: "tenant-corpus",
    rank: 0,
    discoveredAt: snapshot.acquiredAt,
    proposedUrl: snapshot.originalUrl ?? `https://corpus.invalid/${encodeURIComponent(snapshotId)}`,
    title: null,
    snippet: null,
    providerRating: null,
    admissible: false,
  };
}

function normalizeUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function createBudget(environment: RunEnvironment, options: RetrievalOptions) {
  const prior = options.priorExternalRequests ?? 0;
  let used = 0;
  let totalCost = options.priorCostUsd ?? 0;
  let stageCost = 0;
  let totalCostKnown =
    prior === 0 || (options.priorCostUsd !== null && options.priorCostUsd !== undefined);
  let stageCostKnown = true;
  return {
    canSpend(amount: number, reserve = 0) {
      return prior + used + amount + reserve <= environment.context.budget.maxExternalRequests;
    },
    spend(amount: number) {
      used += amount;
    },
    addCost(amount: number | null) {
      if (amount === null) {
        totalCostKnown = false;
        stageCostKnown = false;
      } else {
        totalCost += amount;
        stageCost += amount;
      }
    },
    costExceeded() {
      const maximum = environment.context.budget.maxCostUsd;
      return maximum !== null && (!totalCostKnown || totalCost > maximum);
    },
    usedInStage: () => used,
    totalCost: () => (stageCostKnown ? stageCost : null),
  };
}

function createAudit(environment: RunEnvironment) {
  return async (
    kind:
      | "stage_started"
      | "stage_finished"
      | "external_request"
      | "budget_consumed"
      | "validation_rejected"
      | "cancellation",
    message: string,
    claimId: string | null,
    snapshotId: string | null,
  ) =>
    environment.ports.audit.record({
      runId: environment.context.runId,
      stage: "retrieve_evidence",
      kind,
      message,
      claimId,
      snapshotId,
      at: environment.ports.clock.now(),
    });
}

function isCanceled(environment: RunEnvironment) {
  return environment.signal.aborted || environment.context.cancellation.requested;
}

function issue(
  code: AnalysisIssue["code"],
  message: string,
  severity: AnalysisIssue["severity"] = "warning",
  claimId: string | null = null,
  snapshotId: string | null = null,
  url: string | null = null,
): AnalysisIssue {
  return { code, severity, message, claimId, snapshotId, url };
}

function emptyData(stoppingReason: RetrieveEvidenceData["stoppingReason"]): RetrieveEvidenceData {
  return {
    candidates: [],
    snapshots: [],
    admittedSnapshotIds: [],
    budgetUsed: { externalRequests: 0, costUsd: 0 },
    stoppingReason,
  };
}
