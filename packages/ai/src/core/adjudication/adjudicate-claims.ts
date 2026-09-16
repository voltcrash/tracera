import {
  decisionSchema,
  type Calibration,
  type Challenge,
  type ClaimLabel,
  type ClaimV2,
  type CoreIssue,
  type Decision,
  type DecisionReasonCode,
  type DocumentSnapshot,
  type EvidenceAssessment,
  type StageResult,
  type SufficiencyFeedback,
} from "@repo/contracts/core-v2";
import {
  buildChallengeInput,
  buildSufficiencyFeedback,
  createAssessEvidenceV2,
} from "../evidence/index";
import { createRetrieveEvidenceV2 } from "../retrieval/index";
import type {
  AdjudicateClaimsV2,
  AdjudicateClaimsV2Data,
  AuditEvent,
  GenerationRequest,
  PortUsage,
  RunEnvironment,
} from "../types";
import { buildChallengeRequest, buildDraftRequest } from "./generation";
import {
  hasSufficientOrigins,
  isAdjudicable,
  isDecisive,
  opposingEvidence,
  partitionEvidence,
  resolveDraft,
  scopeAbstention,
  validateChallenge,
  withRelation,
  type DraftResolution,
} from "./policy";
import type { AdjudicationOptions, TargetedEvidence } from "./types";

export const PENDING_CALIBRATION: Calibration = {
  applicability: "unavailable",
  calibratedCorrectness: null,
  calibratorVersion: null,
  reason: "Calibration is applied by the calibrate_decisions stage.",
};

export const adjudicateClaimsV2: AdjudicateClaimsV2 = createAdjudicateClaimsV2();

export function createAdjudicateClaimsV2(options: AdjudicationOptions = {}): AdjudicateClaimsV2 {
  return async (input, environment) => adjudicate(input, environment, options);
}

class Canceled extends Error {}

type ChallengeOutcome = { ok: true; label: ClaimLabel } | { ok: false; reason: string };

async function adjudicate(
  input: Parameters<AdjudicateClaimsV2>[0],
  environment: RunEnvironment,
  options: AdjudicationOptions,
): Promise<StageResult<AdjudicateClaimsV2Data>> {
  const { clock } = environment.ports;
  const startedAt = clock.now();
  const startedMs = clock.monotonicMs();
  const issues: CoreIssue[] = [];
  const decisions: Decision[] = [];
  const priorRequests = options.priorExternalRequests ?? 0;
  let totalRequests = priorRequests;
  let totalCostUsd =
    priorRequests === 0 ? (options.priorCostUsd ?? 0) : (options.priorCostUsd ?? null);
  let inputTokens: number | null = 0;
  let outputTokens: number | null = 0;
  let stageCostUsd: number | null = 0;
  let omitted = 0;

  await audit("stage_started", "Verdict adjudication started.");
  try {
    ensureActive();
    const claims = uniqueClaims(input.claims);
    const claimIds = new Set(claims.map(({ id }) => id));
    for (const assessment of input.assessments) {
      if (!claimIds.has(assessment.claimId))
        warn(
          "citation_validation_failed",
          `Assessment ${assessment.id} references an unknown claim and was not used.`,
          assessment.claimId,
          assessment.snapshotId,
        );
    }
    const graphsByClaim = new Map(input.graphs.map((graph) => [graph.claimId, graph]));
    for (const graph of input.graphs) {
      if (!claimIds.has(graph.claimId))
        warn(
          "citation_validation_failed",
          "A provenance graph references an unknown claim.",
          graph.claimId,
        );
    }
    const snapshots = await loadSnapshots(claims, input.assessments);
    if (snapshots === null) return finish("failed", null);

    for (const claim of claims.filter(isAdjudicable)) {
      ensureActive();
      const decision = await adjudicateClaim(claim, graphsByClaim.get(claim.id), snapshots);
      if (decision === null) {
        omitted += 1;
        continue;
      }
      decisions.push(decisionSchema.parse(decision));
    }
  } catch (error) {
    if (error instanceof Canceled || isCanceled()) {
      issues.push(issue("cancellation_requested", "Verdict adjudication was canceled."));
      await audit(
        "cancellation",
        "Verdict adjudication canceled; no partial decisions were returned.",
      );
      return finish("failed", null);
    }
    throw error;
  }

  const status =
    omitted > 0 || issues.some(({ severity }) => severity !== "info") ? "partial" : "complete";
  return finish(status, { decisions });

  async function adjudicateClaim(
    claim: ClaimV2,
    graph: (typeof input.graphs)[number] | undefined,
    snapshots: Map<string, DocumentSnapshot>,
  ): Promise<Decision | null> {
    const scope = scopeAbstention(claim);
    if (scope !== null)
      return abstain(
        claim,
        scope,
        "The claim scope is not checkable as written, so no verdict was proposed.",
      );

    const assessed = new Set(
      input.assessments
        .filter(({ claimId }) => claimId === claim.id)
        .map(({ snapshotId }) => snapshotId),
    );
    const stale = graph?.nodes.filter(
      ({ snapshotId, claimPresentInContent }) => claimPresentInContent && !assessed.has(snapshotId),
    );
    if (stale !== undefined && stale.length > 0) {
      warn(
        "deferred_processing",
        "Provenance acquired claim evidence that was not supplied through assessment; adjudication refused stale assessments.",
        claim.id,
        stale[0]!.snapshotId,
      );
      return abstain(
        claim,
        ["awaiting_deferred_processing"],
        "Newly acquired provenance evidence must be assessed before this claim can be adjudicated.",
      );
    }

    const claimAssessments = input.assessments.filter(({ claimId }) => claimId === claim.id);
    let partition = partitionEvidence(claim, claimAssessments, snapshots);
    const duplicateIds =
      claimAssessments.length !== new Set(claimAssessments.map(({ id }) => id)).size;
    if (duplicateIds) partition.integrityFailures.push("duplicate assessment IDs");
    if (partition.integrityFailures.length > 0)
      return integrityFailure(claim, partition.integrityFailures);
    if (partition.needsHumanReview > 0)
      warn(
        "human_review_required",
        `${partition.needsHumanReview} assessment(s) need human review and were not used as decisive evidence.`,
        claim.id,
      );

    if (
      withRelation(partition.usable, "supports").length === 0 &&
      withRelation(partition.usable, "contradicts").length === 0
    ) {
      await audit(
        "decision_gated",
        "Deterministic abstention: no admissible applicable evidence.",
        claim.id,
      );
      return abstain(
        claim,
        ["no_admissible_evidence", ...partition.exclusionReasons],
        "No validated, applicable, admissible evidence supports or contradicts the scoped claim.",
        claimAssessments.length > 0 ? "valid" : "not_checked",
      );
    }

    if (!reserve(2)) return exhausted(claim);
    const draftResponse = await generate(
      buildDraftRequest(buildChallengeInput(claim, partition.usable), environment.signal),
      claim,
    );
    if (draftResponse === null) return null;
    const draft = draftResponse.value;
    const resolution = resolveDraft(draft, claim, partition.usable);
    if (resolution.kind === "invalid") return integrityFailure(claim, [resolution.reason]);
    if (!isDecisive(resolution.label))
      return decision(
        claim,
        resolution,
        resolution.label,
        resolution.reasonCodes,
        notRequired(),
        draft.selfConfidence,
        draft.justification,
      );

    let challenge = await runChallenge(claim, partition.usable);
    if (challenge === null) return null;
    let rounds = 0;
    let current: Extract<DraftResolution, { kind: "resolved" }> = resolution;
    const conflicted = opposingEvidence(resolution.label, partition.usable).length > 0;
    const disagreed = !challenge.ok || challenge.label !== resolution.label;
    if (challenge.ok && (disagreed || conflicted)) {
      const added = await targetedRound(claim, claimAssessments, snapshots);
      if (added !== null) {
        rounds = 1;
        partition = partitionEvidence(claim, [...claimAssessments, ...added], snapshots);
        if (partition.integrityFailures.length > 0)
          return integrityFailure(claim, partition.integrityFailures);
        const reresolved = resolveDraft(draft, claim, partition.usable);
        if (reresolved.kind === "invalid") return integrityFailure(claim, [reresolved.reason]);
        current = reresolved;
        if (!reserve(1)) return exhausted(claim);
        challenge = await runChallenge(claim, partition.usable);
        if (challenge === null) return null;
      }
    }

    const independentLabel = challenge.ok ? challenge.label : null;
    const agreed = challenge.ok ? challenge.label === current.label : null;
    if (!challenge.ok) {
      return decision(
        claim,
        current,
        current.label,
        [...current.reasonCodes, "unresolved_challenge_disagreement"],
        {
          status: "failed",
          independentLabel: null,
          agreed: null,
          targetedRoundsUsed: rounds,
          notes: challenge.reason,
        },
        draft.selfConfidence,
        draft.justification,
      );
    }
    if (!isDecisive(current.label))
      return decision(
        claim,
        current,
        current.label,
        current.reasonCodes,
        {
          status: "unresolved",
          independentLabel,
          agreed,
          targetedRoundsUsed: rounds,
          notes:
            "Targeted evidence changed the scoped evidence sufficiency; no decisive verdict remains.",
        },
        draft.selfConfidence,
        draft.justification,
      );

    const opposing = opposingEvidence(current.label, partition.usable);
    if (agreed && (opposing.length === 0 || (rounds === 1 && !hasSufficientOrigins(opposing)))) {
      return decision(
        claim,
        current,
        current.label,
        current.reasonCodes,
        {
          status: "resolved",
          independentLabel,
          agreed: true,
          targetedRoundsUsed: rounds,
          notes:
            opposing.length === 0
              ? "The independent reassessment agreed without seeing the draft label."
              : "After one targeted round the opposing evidence still lacked independent origins, and the label-blind reassessment agreed.",
        },
        draft.selfConfidence,
        draft.justification,
      );
    }

    const supports = withRelation(partition.usable, "supports");
    const contradicts = withRelation(partition.usable, "contradicts");
    const unresolved: Challenge = {
      status: "unresolved",
      independentLabel,
      agreed,
      targetedRoundsUsed: rounds,
      notes: agreed
        ? "Applicable opposing evidence remained after the permitted targeted round."
        : `The label-blind reassessment proposed ${independentLabel}; the disagreement was persisted without a vote.`,
    };
    await audit("decision_gated", "Unresolved conflict prevented a decisive verdict.", claim.id);
    if (claim.material && hasSufficientOrigins(supports) && hasSufficientOrigins(contradicts)) {
      return decision(
        claim,
        {
          ...current,
          supporting: supports.map(({ id }) => id),
          contradicting: contradicts.map(({ id }) => id),
          corrective: [],
        },
        "mixed",
        ["unresolved_material_conflict"],
        unresolved,
        draft.selfConfidence,
        "Independently sourced, applicable support and contradiction both remain unresolved.",
      );
    }
    return decision(
      claim,
      current,
      current.label,
      [
        ...current.reasonCodes,
        agreed ? "unresolved_material_conflict" : "unresolved_challenge_disagreement",
      ],
      unresolved,
      draft.selfConfidence,
      draft.justification,
    );
  }

  async function runChallenge(
    claim: ClaimV2,
    usable: EvidenceAssessment[],
  ): Promise<ChallengeOutcome | null> {
    const response = await generate(
      buildChallengeRequest(buildChallengeInput(claim, usable), environment.signal),
      claim,
    );
    if (response === null) return null;
    const validated = validateChallenge(response.value, claim, usable);
    if (validated.valid) return { ok: true, label: validated.label };
    warn("citation_validation_failed", `Challenge output rejected: ${validated.reason}`, claim.id);
    await audit("validation_rejected", "Invalid challenge output rejected.", claim.id);
    return { ok: false, reason: `Challenge output rejected: ${validated.reason}` };
  }

  async function targetedRound(
    claim: ClaimV2,
    claimAssessments: EvidenceAssessment[],
    snapshots: Map<string, DocumentSnapshot>,
  ): Promise<EvidenceAssessment[] | null> {
    const targeted = options.targetedReassessment;
    const priorRounds = options.priorTargetedRounds ?? 0;
    if (targeted === undefined) {
      warn(
        "capability_unavailable",
        "No targeted retrieval capability was configured for challenge reassessment.",
        claim.id,
      );
      return null;
    }
    if (priorRounds >= environment.context.budget.maxTargetedRetrievalRounds) {
      warn(
        "budget_exhausted",
        "The run had no targeted retrieval round left for challenge reassessment.",
        claim.id,
      );
      return null;
    }
    // A retrieval request, an assessment request and the post-round challenge.
    if (!reserve(3)) {
      warn(
        "budget_exhausted",
        "The shared request cap left no room for a targeted round.",
        claim.id,
      );
      return null;
    }
    const round = priorRounds + 1;
    const retrieve =
      targeted.createRetrieve?.({
        priorExternalRequests: totalRequests,
        priorCostUsd: totalCostUsd,
      }) ??
      createRetrieveEvidenceV2({
        ...targeted.retrievalOptions,
        priorExternalRequests: totalRequests,
        priorCostUsd: totalCostUsd,
      });
    const retrieval = await retrieve(
      {
        claims: [claim],
        snapshots: [...snapshots.values()],
        round,
        sufficiency: [targetedFeedback(claim, claimAssessments)],
      },
      {
        ...environment,
        context: {
          ...environment.context,
          budget: {
            ...environment.context.budget,
            maxExternalRequests: Math.max(
              totalRequests,
              environment.context.budget.maxExternalRequests - 2,
            ),
          },
        },
      },
    );
    charge(retrieval.metrics);
    issues.push(...retrieval.issues);
    await audit(
      "external_request",
      `Targeted challenge retrieval finished with status ${retrieval.status}.`,
      claim.id,
    );
    ensureActive();
    if (retrieval.data === null) return null;

    const known = new Set(claimAssessments.map(({ snapshotId }) => snapshotId));
    const accepted: DocumentSnapshot[] = [];
    for (const snapshot of retrieval.data.snapshots) {
      const existing = snapshots.get(snapshot.id);
      if (existing !== undefined && existing.contentHash !== snapshot.contentHash) {
        warn(
          "citation_validation_failed",
          `Conflicting immutable snapshot ID rejected: ${snapshot.id}.`,
          claim.id,
          snapshot.id,
        );
        continue;
      }
      snapshots.set(snapshot.id, snapshot);
      accepted.push(snapshot);
    }
    const acceptedIds = new Set(accepted.map(({ id }) => id));
    const admitted = retrieval.data.admittedSnapshotIds.filter(
      (id) => acceptedIds.has(id) && !known.has(id),
    );
    let assessments: EvidenceAssessment[] = [];
    if (admitted.length > 0) {
      const maxGenerationRequests = Math.max(
        0,
        environment.context.budget.maxExternalRequests - totalRequests - 1,
      );
      const assess =
        targeted.createAssess?.({ maxGenerationRequests }) ??
        createAssessEvidenceV2({ maxGenerationRequests });
      const assessment = await assess(
        {
          claims: [claim],
          snapshots: accepted.filter(({ id }) => admitted.includes(id)),
          admittedSnapshotIds: admitted,
        },
        environment,
      );
      charge(assessment.metrics);
      issues.push(...assessment.issues);
      ensureActive();
      assessments = (assessment.data?.assessments ?? []).filter(
        ({ claimId }) => claimId === claim.id,
      );
    }
    const evidence: TargetedEvidence = {
      claimId: claim.id,
      round,
      candidates: retrieval.data.candidates,
      snapshots: accepted,
      admittedSnapshotIds: admitted,
      assessments,
    };
    try {
      await targeted.record(evidence, environment.signal);
    } catch (error) {
      ensureActive();
      warn(
        "provider_failure",
        `Targeted evidence could not be recorded, so it was not used: ${error instanceof Error ? error.message : "unknown error"}`,
        claim.id,
      );
      return null;
    }
    return assessments;
  }

  function targetedFeedback(
    claim: ClaimV2,
    assessments: EvidenceAssessment[],
  ): SufficiencyFeedback {
    const base = buildSufficiencyFeedback([claim], assessments)[0];
    const missing = new Set(base?.missing ?? []);
    missing.add("disconfirming_evidence");
    missing.add("primary_record");
    const queries = [
      ...(base?.suggestedQueries ?? []),
      { query: `${claim.text} contrary evidence`, intent: "disconfirming" as const },
      { query: `${claim.text} official primary record`, intent: "primary_source" as const },
    ];
    return {
      claimId: claim.id,
      sufficient: false,
      missing: [...missing],
      suggestedQueries: [
        ...new Map(queries.map((query) => [`${query.intent}\0${query.query}`, query])).values(),
      ],
      independentOriginCount: base?.independentOriginCount ?? 0,
      unknownDependenceCount: base?.unknownDependenceCount ?? 0,
    };
  }

  async function generate<Value>(
    request: GenerationRequest<Value>,
    claim: ClaimV2,
  ): Promise<{ value: Value } | null> {
    ensureActive();
    totalRequests += 1;
    await audit(
      "external_request",
      `Structured ${request.schemaName} generation requested.`,
      claim.id,
    );
    try {
      const response = await environment.ports.generation.generate(request);
      addUsage(response.usage);
      return { value: request.schema.parse(response.value) };
    } catch (error) {
      ensureActive();
      inputTokens = outputTokens = stageCostUsd = totalCostUsd = null;
      warn(
        "provider_failure",
        `${request.schemaName} failed; the claim was omitted rather than guessed: ${error instanceof Error ? error.message : "unknown error"}`,
        claim.id,
      );
      return null;
    }
  }

  function decision(
    claim: ClaimV2,
    cited: Extract<DraftResolution, { kind: "resolved" }>,
    label: ClaimLabel,
    reasonCodes: DecisionReasonCode[],
    challenge: Challenge,
    rawModelConfidence: number | null,
    justification: string,
  ): Decision {
    const decisive = isDecisive(label);
    return {
      claimId: claim.id,
      diagnosticLabel: label,
      publishedLabel: decisive ? "unverified" : label,
      reasonCodes: unique(decisive ? [...reasonCodes, "calibration_unavailable"] : reasonCodes),
      supportingAssessmentIds: cited.supporting,
      contradictingAssessmentIds: cited.contradicting,
      correctiveContextAssessmentIds: cited.corrective,
      justification,
      challenge,
      calibration: PENDING_CALIBRATION,
      rawModelConfidence,
      citationIntegrity: "valid",
    };
  }

  function abstain(
    claim: ClaimV2,
    reasonCodes: DecisionReasonCode[],
    justification: string,
    citationIntegrity: Decision["citationIntegrity"] = "not_checked",
  ): Decision {
    return {
      claimId: claim.id,
      diagnosticLabel: "unverified",
      publishedLabel: "unverified",
      reasonCodes: unique(reasonCodes),
      supportingAssessmentIds: [],
      contradictingAssessmentIds: [],
      correctiveContextAssessmentIds: [],
      justification,
      challenge: notRequired(),
      calibration: PENDING_CALIBRATION,
      rawModelConfidence: null,
      citationIntegrity,
    };
  }

  async function integrityFailure(claim: ClaimV2, reasons: string[]): Promise<Decision> {
    for (const reason of reasons)
      warn(
        "citation_validation_failed",
        `Adjudication rejected invalid evidence reference: ${reason}`,
        claim.id,
      );
    await audit(
      "validation_rejected",
      "Decisive output rejected because citation checks failed.",
      claim.id,
    );
    return {
      ...abstain(
        claim,
        ["citation_validation_failed"],
        "Citation checks failed, so no verdict can be released.",
      ),
      citationIntegrity: "invalid",
    };
  }

  function exhausted(claim: ClaimV2) {
    warn(
      "budget_exhausted",
      "The shared request cap was exhausted before adjudication and challenge.",
      claim.id,
    );
    return abstain(
      claim,
      ["budget_exhausted_before_resolution"],
      "The run budget was exhausted before the claim could be adjudicated and challenged.",
    );
  }

  async function loadSnapshots(claims: ClaimV2[], assessments: EvidenceAssessment[]) {
    const ids = new Set<string>(claims.map(({ documentId }) => documentId));
    for (const assessment of assessments) {
      ids.add(assessment.snapshotId);
      for (const locator of assessment.dependenceLocators) ids.add(locator.snapshotId);
    }
    try {
      const loaded = await environment.ports.snapshots.getMany([...ids].sort(), environment.signal);
      const map = new Map<string, DocumentSnapshot>();
      for (const snapshot of loaded) if (ids.has(snapshot.id)) map.set(snapshot.id, snapshot);
      return map;
    } catch (error) {
      ensureActive();
      warn(
        "snapshot_unavailable",
        `Immutable snapshots could not be read for citation checks: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return null;
    }
  }

  function uniqueClaims(claims: ClaimV2[]) {
    const seen = new Set<string>();
    return claims.filter((claim) => {
      if (seen.has(claim.id)) {
        warn("citation_validation_failed", `Duplicate claim ID rejected: ${claim.id}.`, claim.id);
        return false;
      }
      seen.add(claim.id);
      return true;
    });
  }

  function reserve(requests: number) {
    const { maxExternalRequests, maxCostUsd } = environment.context.budget;
    if (totalRequests + requests > maxExternalRequests) return false;
    return maxCostUsd === null || (totalCostUsd !== null && totalCostUsd <= maxCostUsd);
  }

  function charge(metrics: StageResult<unknown>["metrics"]) {
    totalRequests += metrics.externalRequests;
    addUsage({
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      costUsd: metrics.costUsd,
    });
  }

  function addUsage(usage: PortUsage) {
    inputTokens = sum(inputTokens, usage.inputTokens);
    outputTokens = sum(outputTokens, usage.outputTokens);
    stageCostUsd = sum(stageCostUsd, usage.costUsd);
    totalCostUsd = sum(totalCostUsd, usage.costUsd);
  }

  function isCanceled() {
    return environment.signal.aborted || environment.context.cancellation.requested;
  }

  function ensureActive() {
    if (isCanceled()) throw new Canceled();
  }

  function warn(
    code: CoreIssue["code"],
    message: string,
    claimId: string | null = null,
    snapshotId: string | null = null,
  ) {
    issues.push(issue(code, message, claimId, snapshotId));
  }

  function audit(kind: AuditEvent["kind"], message: string, claimId: string | null = null) {
    return environment.ports.audit.record({
      runId: environment.context.runId,
      stage: "adjudicate_claims",
      kind,
      message,
      claimId,
      snapshotId: null,
      at: clock.now(),
    });
  }

  async function finish(
    status: StageResult<AdjudicateClaimsV2Data>["status"],
    data: AdjudicateClaimsV2Data | null,
  ): Promise<StageResult<AdjudicateClaimsV2Data>> {
    await audit("stage_finished", `Verdict adjudication finished with status ${status}.`);
    return {
      status,
      data,
      issues,
      metrics: {
        startedAt,
        completedAt: clock.now(),
        durationMs: Math.max(0, clock.monotonicMs() - startedMs),
        externalRequests: totalRequests - priorRequests,
        inputTokens,
        outputTokens,
        costUsd: stageCostUsd,
      },
    };
  }
}

function notRequired(): Challenge {
  return {
    status: "not_required",
    independentLabel: null,
    agreed: null,
    targetedRoundsUsed: 0,
    notes: "No decisive verdict was proposed.",
  };
}

function unique<Value>(values: Value[]) {
  return [...new Set(values)];
}

function sum(total: number | null, value: number | null) {
  return total === null || value === null ? null : total + value;
}

function issue(
  code: CoreIssue["code"],
  message: string,
  claimId: string | null = null,
  snapshotId: string | null = null,
): CoreIssue {
  return { code, severity: "warning", message, claimId, snapshotId, url: null };
}
