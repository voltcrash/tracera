import {
  CORE_V2_FOCUSED_SCORE_FORMULA_VERSION,
  CORE_V2_RESOLUTION_COVERAGE_THRESHOLD,
  CORE_V2_SCORE_FORMULA_VERSION,
  claimSchema,
  decisionSchema,
  documentSnapshotSchema,
  evidenceAssessmentSchema,
  focusedSelectionSchema,
  inputCoverageSchema,
  instantSchema,
  provenanceGraphSchema,
  scorecardSchema,
  type ClaimLabel,
  type ClaimV2,
  type CoreIssue,
  type DocumentSnapshot,
  type FocusedSelection,
  type ScoreNullReason,
  type Scorecard,
  type StageResult,
} from "@repo/contracts/core-v2";
import { buildPresentationFindings } from "../framing/index";
import type { ScoreReportV2, ScoreReportV2Data } from "../types";

export const scoreReportV2: ScoreReportV2 = (input) => {
  const metrics = {
    startedAt: input.at,
    completedAt: input.at,
    durationMs: 0,
    externalRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };

  try {
    instantSchema.parse(input.at);
    const claims = input.claims.map((claim) => claimSchema.parse(claim));
    const assessments = input.assessments.map((assessment) =>
      evidenceAssessmentSchema.parse(assessment),
    );
    const graphs = input.graphs.map((graph) => provenanceGraphSchema.parse(graph));
    const coverage = input.coverage.map((item) => inputCoverageSchema.parse(item));
    const claimById = uniqueById(claims, "claim");
    const decisions = input.decisions.map((decision) => decisionSchema.parse(decision));
    const decisionByClaim = uniqueByClaimId(decisions);
    const assessmentsById = uniqueById(assessments, "assessment");
    uniqueByClaimId(graphs);
    const focusedSelection = input.focusedSelection
      ? focusedSelectionSchema.parse(input.focusedSelection)
      : undefined;
    const snapshots = input.snapshots?.map((snapshot) => documentSnapshotSchema.parse(snapshot));
    const snapshotsById = snapshots === undefined ? null : uniqueById(snapshots, "snapshot");

    for (const claim of claims) {
      if (claim.parentClaimId !== null) requireClaimLink(claimById, claim, claim.parentClaimId);
      if (claim.duplicateOfClaimId !== null)
        requireClaimLink(claimById, claim, claim.duplicateOfClaimId);
    }

    for (const assessment of assessments) requireClaim(claimById, assessment.claimId);
    validateDecisionReferences(decisions, assessments);
    if (snapshotsById !== null) validateSnapshotCitations(assessments, graphs, snapshotsById);
    for (const graph of graphs) requireClaim(claimById, graph.claimId);
    for (const item of coverage) {
      for (const segment of item.segments) {
        for (const claimId of segment.claimIds) requireClaim(claimById, claimId);
      }
    }

    const canonicalFactual = claims.filter(
      (claim) => claim.duplicateOfClaimId === null && claim.coverageDisposition === "factual_claim",
    );
    const canonicalFactualIds = new Set(canonicalFactual.map(({ id }) => id));
    for (const decision of decisions) {
      if (!canonicalFactualIds.has(decision.claimId))
        throw new Error(`Decision ${decision.claimId} is not for a canonical factual claim.`);
    }

    const selected = focusedSelection
      ? focusedClaims(focusedSelection, claimById, canonicalFactual, decisions)
      : null;
    const scopedClaims = selected?.claims ?? canonicalFactual;
    const scopedClaimIds = new Set(scopedClaims.map(({ id }) => id));
    const scopedDecisions = selected
      ? decisions
      : decisions.filter((decision) => scopedClaimIds.has(decision.claimId));
    const decisionForScopedClaims = new Map(
      scopedDecisions.map((decision) => [decision.claimId, decision]),
    );
    const eligible = selected
      ? scopedClaims
      : scopedClaims.filter((claim) => decisionByClaim.has(claim.id));
    const selectedClaimCount = selected?.count;
    const omittedClaims = selected
      ? selected.count - scopedDecisions.length
      : scopedClaims.length - eligible.length;
    const deferredClaims =
      selected?.selection.inventory.deferredClaims ??
      claims.filter(
        (claim) => claim.duplicateOfClaimId === null && claim.coverageDisposition === "deferred",
      ).length;
    const counts = verdictCounts(scopedDecisions);
    const resolved = counts.supported + counts.contradicted;
    const denominator = selectedClaimCount ?? eligible.length;
    const resolutionCoverage = denominator === 0 ? null : resolved / denominator;
    const materialMixedOrMisleadingOpen = eligible.some((claim) => {
      const label = decisionForScopedClaims.get(claim.id)?.publishedLabel;
      return claim.material && (label === "mixed" || label === "misleading");
    });
    const focusedCitationFailure = selected
      ? hasFocusedCitationFailure(scopedDecisions, assessmentsById)
      : false;
    const focusedConflict = selected
      ? hasFocusedConflict(scopedClaims, scopedDecisions, assessments, graphs)
      : false;
    const focusedCoverageIncomplete =
      selected !== null &&
      (selected.selection.coverage.partialDocuments > 0 ||
        selected.selection.coverage.omittedCharacters > 0);
    const focusedSnapshotsUnavailable = selected !== null && (snapshotsById?.size ?? 0) === 0;
    const nullReasons = scoreNullReasons({
      eligibleFactualClaims: denominator,
      resolved,
      resolutionCoverage,
      inputStatus: input.inputStatus,
      extractionStatus: input.extractionStatus,
      materialMixedOrMisleadingOpen,
      citationValidationFailed: focusedCitationFailure,
      unresolvedConflict: focusedConflict,
      inventoryStatus: focusedSelection?.inventoryStatus,
      focusedCoverageIncomplete,
      focusedSnapshotsUnavailable,
    });
    const presentationFindings = buildPresentationFindings({
      claims: selected ? scopedClaims : claims,
      decisions: selected ? scopedDecisions : decisions,
      assessments: selected
        ? assessments.filter(({ claimId }) => scopedClaimIds.has(claimId))
        : assessments,
    });
    const scorecard = scorecardSchema.parse({
      formulaVersion: selected
        ? CORE_V2_FOCUSED_SCORE_FORMULA_VERSION
        : CORE_V2_SCORE_FORMULA_VERSION,
      factualScore: nullReasons.length === 0 ? (100 * counts.supported) / resolved : null,
      nullReasons,
      ...(selected ? { selectedClaimCount: selected.count, resolvedClaimCount: resolved } : {}),
      counts: {
        ...counts,
        eligibleFactualClaims: denominator,
        deferredClaims,
        omittedClaims,
      },
      resolutionCoverage,
      extractionCoverage: extractionCoverage(coverage),
      inputStatus: input.inputStatus,
      extractionStatus: input.extractionStatus,
      materialMixedOrMisleadingOpen,
      evidence: evidenceSummary(
        selected ? assessments.filter(({ claimId }) => scopedClaimIds.has(claimId)) : assessments,
      ),
      origin: originSummary(
        selected ? graphs.filter(({ claimId }) => scopedClaimIds.has(claimId)) : graphs,
      ),
      presentationFindings,
    });
    return { status: "complete", data: { scorecard, presentationFindings }, issues: [], metrics };
  } catch (error) {
    const issue: CoreIssue = {
      code: "citation_validation_failed",
      severity: "error",
      message: `Scoring input was rejected: ${error instanceof Error ? error.message : "unknown error"}`,
      claimId: null,
      snapshotId: null,
      url: null,
    };
    return { status: "failed", data: null, issues: [issue], metrics };
  }
};

/** Focused scoring is explicit at the call site and never falls back to a full score. */
export const scoreFocusedReportV2: ScoreReportV2 = (input) => {
  if (input.focusedSelection === undefined) {
    const metrics = zeroMetrics(input.at);
    return {
      status: "failed",
      data: null,
      issues: [
        {
          code: "citation_validation_failed",
          severity: "error",
          message: "Focused scoring requires focused selection metadata.",
          claimId: null,
          snapshotId: null,
          url: null,
        },
      ],
      metrics,
    };
  }
  return scoreReportV2(input);
};

function verdictCounts(decisions: Array<{ publishedLabel: ClaimLabel }>) {
  const counts = { supported: 0, contradicted: 0, misleading: 0, mixed: 0, unverified: 0 };
  for (const decision of decisions) counts[decision.publishedLabel] += 1;
  return counts;
}

function scoreNullReasons(input: {
  eligibleFactualClaims: number;
  resolved: number;
  resolutionCoverage: number | null;
  inputStatus: Scorecard["inputStatus"];
  extractionStatus: Scorecard["extractionStatus"];
  materialMixedOrMisleadingOpen: boolean;
  citationValidationFailed: boolean;
  unresolvedConflict: boolean;
  inventoryStatus?: FocusedSelection["inventoryStatus"];
  focusedCoverageIncomplete: boolean;
  focusedSnapshotsUnavailable: boolean;
}) {
  const reasons: ScoreNullReason[] = [];
  if (input.eligibleFactualClaims === 0) reasons.push("no_checkable_claims");
  if (input.resolved === 0) reasons.push("zero_resolved_denominator");
  if (input.inputStatus !== "complete") reasons.push("partial_input");
  if (input.extractionStatus !== "complete") reasons.push("partial_extraction");
  if (input.inputStatus === "failed" || input.extractionStatus === "failed")
    reasons.push("run_failed");
  if (
    input.resolutionCoverage !== null &&
    input.resolutionCoverage < CORE_V2_RESOLUTION_COVERAGE_THRESHOLD
  )
    reasons.push("resolution_coverage_below_threshold");
  if (input.citationValidationFailed) reasons.push("citation_validation_failed");
  if (input.unresolvedConflict) reasons.push("unresolved_conflict");
  if (input.materialMixedOrMisleadingOpen) reasons.push("material_mixed_or_misleading_open");
  if (input.focusedCoverageIncomplete) reasons.push("partial_extraction");
  if (input.focusedSnapshotsUnavailable) reasons.push("citation_validation_failed");
  if (input.inventoryStatus !== undefined && input.inventoryStatus !== "complete") {
    reasons.push("partial_input");
    if (input.inventoryStatus === "failed") reasons.push("run_failed");
  }
  return [...new Set(reasons)];
}

function focusedClaims(
  selection: FocusedSelection,
  claimById: Map<string, ClaimV2>,
  canonicalFactual: ClaimV2[],
  decisions: Array<ReturnType<typeof decisionSchema.parse>>,
) {
  const selectedIds = new Set(selection.selectedClaimIds);
  if (selectedIds.size !== selection.selectedClaimIds.length) {
    throw new Error("Focused selection contains duplicate selected claim IDs.");
  }
  const analyzedIds = selection.claims
    .filter(({ status }) => status === "analyzed")
    .map(({ claimId }) => claimId);
  if (!sameIds(analyzedIds, selection.selectedClaimIds)) {
    throw new Error("Focused selection analyzed entries do not match selected claim IDs.");
  }
  const canonicalFactualIds = new Set(canonicalFactual.map(({ id }) => id));
  const claims = selection.selectedClaimIds.map((id) => {
    const claim = claimById.get(id);
    if (
      claim === undefined ||
      !canonicalFactualIds.has(id) ||
      claim.checkability !== "checkable" ||
      !claim.material
    ) {
      throw new Error(`Focused selection contains an ineligible claim: ${id}.`);
    }
    return claim;
  });
  for (const decision of decisions) {
    if (!selectedIds.has(decision.claimId)) {
      throw new Error(
        `Focused score received a decision outside the selected claim set: ${decision.claimId}.`,
      );
    }
  }
  return { claims, count: selection.selectedClaimIds.length, selection };
}

function hasFocusedCitationFailure(
  decisions: Array<ReturnType<typeof decisionSchema.parse>>,
  assessmentsById: Map<string, ReturnType<typeof evidenceAssessmentSchema.parse>>,
) {
  for (const decision of decisions) {
    const decisive = ["supported", "contradicted", "misleading"].includes(decision.publishedLabel);
    const citedIds = [
      ...decision.supportingAssessmentIds,
      ...decision.contradictingAssessmentIds,
      ...decision.correctiveContextAssessmentIds,
    ];
    if (
      decision.citationIntegrity === "invalid" ||
      decision.reasonCodes.includes("citation_validation_failed") ||
      decision.focusedPublication?.gate === "invalid_citation" ||
      decision.focusedPublication?.gate === "failed_applicability" ||
      decision.calibration.applicability === "in_scope" ||
      (decisive &&
        (citedIds.length === 0 ||
          decision.citationIntegrity !== "valid" ||
          decision.focusedPublication?.status !== "published" ||
          decision.focusedPublication.gate !== "passed"))
    ) {
      return true;
    }
    if (
      citedIds.some((id) => {
        const assessment = assessmentsById.get(id);
        return (
          assessment === undefined ||
          Object.values(assessment.applicability).some((value) => value !== "applicable")
        );
      })
    ) {
      return true;
    }
  }
  return false;
}

function hasFocusedConflict(
  claims: ClaimV2[],
  decisions: Array<ReturnType<typeof decisionSchema.parse>>,
  assessments: Array<ReturnType<typeof evidenceAssessmentSchema.parse>>,
  graphs: Array<ReturnType<typeof provenanceGraphSchema.parse>>,
) {
  const claimIds = new Set(claims.map(({ id }) => id));
  const decisionByClaim = new Map(decisions.map((decision) => [decision.claimId, decision]));
  if (
    decisions.some(
      (decision) =>
        decision.challenge.status === "unresolved" ||
        decision.challenge.status === "failed" ||
        decision.challenge.agreed === false ||
        decision.reasonCodes.includes("unresolved_material_conflict") ||
        decision.reasonCodes.includes("unresolved_challenge_disagreement") ||
        decision.focusedPublication?.gate === "unresolved_conflict" ||
        decision.focusedPublication?.gate === "challenge_unresolved" ||
        decision.diagnosticLabel === "mixed" ||
        decision.publishedLabel === "mixed",
    )
  ) {
    return true;
  }
  if (
    graphs.some(
      (graph) =>
        claimIds.has(graph.claimId) &&
        (graph.chronologyConflicts.length > 0 || graph.cycles.length > 0),
    )
  ) {
    return true;
  }
  const byClaim = new Map<string, Set<string>>();
  for (const assessment of assessments) {
    if (
      !claimIds.has(assessment.claimId) ||
      assessment.validationStatus !== "validated" ||
      Object.values(assessment.applicability).some((value) => value !== "applicable")
    )
      continue;
    const relations = byClaim.get(assessment.claimId) ?? new Set<string>();
    relations.add(assessment.relation);
    byClaim.set(assessment.claimId, relations);
  }
  return [...byClaim.entries()].some(
    ([claimId, relations]) =>
      decisionByClaim.get(claimId)?.publishedLabel !== "misleading" &&
      relations.has("supports") &&
      relations.has("contradicts"),
  );
}

function validateSnapshotCitations(
  assessments: Array<ReturnType<typeof evidenceAssessmentSchema.parse>>,
  graphs: Array<ReturnType<typeof provenanceGraphSchema.parse>>,
  snapshots: Map<string, DocumentSnapshot>,
) {
  for (const assessment of assessments) {
    const snapshot = snapshots.get(assessment.snapshotId);
    if (snapshot === undefined)
      throw new Error(`Assessment cites an unknown snapshot: ${assessment.snapshotId}.`);
    requireExactQuote(snapshot, assessment.excerpt.span, assessment.excerpt.quote, "assessment");
    for (const locator of assessment.dependenceLocators) {
      const target = snapshots.get(locator.snapshotId);
      if (target === undefined)
        throw new Error(`Dependence locator cites an unknown snapshot: ${locator.snapshotId}.`);
      requireExactQuote(target, locator.span, locator.quote, "dependence");
    }
  }
  for (const graph of graphs) {
    for (const edge of graph.edges) {
      for (const locator of edge.supportingLocators) {
        const snapshot = snapshots.get(locator.snapshotId);
        if (snapshot === undefined)
          throw new Error(`Provenance locator cites an unknown snapshot: ${locator.snapshotId}.`);
        requireExactQuote(snapshot, locator.span, locator.quote, "provenance");
      }
    }
  }
}

function requireExactQuote(
  snapshot: DocumentSnapshot,
  span: { start: number; end: number },
  quote: string,
  kind: string,
) {
  if (
    span.end > snapshot.normalizedText.length ||
    snapshot.normalizedText.slice(span.start, span.end) !== quote
  ) {
    throw new Error(`${kind} offsets do not reproduce the quoted snapshot text.`);
  }
}

function sameIds(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    new Set(left).size === new Set(right).size &&
    left.every((id) => right.includes(id))
  );
}

function zeroMetrics(at: string) {
  return {
    startedAt: at,
    completedAt: at,
    durationMs: 0,
    externalRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

function extractionCoverage(coverage: Parameters<ScoreReportV2>[0]["coverage"]) {
  const total = coverage.reduce((sum, item) => sum + item.charactersTotal, 0);
  if (total === 0) return null;
  return coverage.reduce((sum, item) => sum + item.charactersCovered, 0) / total;
}

function evidenceSummary(assessments: Parameters<ScoreReportV2>[0]["assessments"]) {
  const validated = assessments.filter(({ validationStatus }) => validationStatus === "validated");
  return {
    admittedSnapshots: new Set(assessments.map(({ snapshotId }) => snapshotId)).size,
    validatedAssessments: validated.length,
    rejectedAssessments: assessments.filter(
      ({ validationStatus }) => validationStatus === "rejected",
    ).length,
    needsHumanReviewAssessments: assessments.filter(
      ({ validationStatus }) => validationStatus === "needs_human_review",
    ).length,
    independentOriginGroups: new Set(
      validated
        .filter(({ dependence }) => dependence === "independent")
        .map(({ dependencyGroupId }) => dependencyGroupId),
    ).size,
    unknownDependenceGroups: new Set(
      validated
        .filter(({ dependence }) => dependence === "unknown")
        .map(({ dependencyGroupId }) => dependencyGroupId),
    ).size,
  };
}

function originSummary(graphs: Parameters<ScoreReportV2>[0]["graphs"]) {
  return {
    claimsWithGraphs: graphs.length,
    claimsWithCandidateRoots: graphs.filter(({ candidateRoots }) => candidateRoots.length > 0)
      .length,
    claimsWithUnresolvedChronology: graphs.filter(
      ({ chronologyConflicts, cycles }) => chronologyConflicts.length > 0 || cycles.length > 0,
    ).length,
    inaccessibleOriginals: graphs.reduce(
      (sum, { inaccessibleOriginals }) => sum + inaccessibleOriginals.length,
      0,
    ),
  };
}

function uniqueById<Value extends { id: string }>(values: Value[], label: string) {
  const map = new Map<string, Value>();
  for (const value of values) {
    if (map.has(value.id)) throw new Error(`Duplicate ${label} ID: ${value.id}.`);
    map.set(value.id, value);
  }
  return map;
}

function uniqueByClaimId<Value extends { claimId: string }>(values: Value[]) {
  const map = new Map<string, Value>();
  for (const value of values) {
    if (map.has(value.claimId)) throw new Error(`Duplicate claim reference: ${value.claimId}.`);
    map.set(value.claimId, value);
  }
  return map;
}

function requireClaim(claimById: Map<string, ClaimV2>, id: string) {
  const claim = claimById.get(id);
  if (claim === undefined) throw new Error(`Unknown claim reference: ${id}.`);
  return claim;
}

function requireClaimLink(claimById: Map<string, ClaimV2>, claim: ClaimV2, id: string) {
  if (id === claim.id) throw new Error(`Claim ${claim.id} cannot reference itself.`);
  requireClaim(claimById, id);
}

function validateDecisionReferences(
  decisions: Parameters<ScoreReportV2>[0]["decisions"],
  assessments: Parameters<ScoreReportV2>[0]["assessments"],
) {
  const byId = new Map(assessments.map((assessment) => [assessment.id, assessment]));
  for (const decision of decisions) {
    const seen = new Set<string>();
    const references: ReadonlyArray<readonly [string, "supports" | "contradicts" | "context"]> = [
      ...decision.supportingAssessmentIds.map((id) => [id, "supports"] as const),
      ...decision.contradictingAssessmentIds.map((id) => [id, "contradicts"] as const),
      ...decision.correctiveContextAssessmentIds.map((id) => [id, "context"] as const),
    ];
    for (const [id, relation] of references) {
      if (seen.has(id))
        throw new Error(`Decision ${decision.claimId} cites assessment ${id} twice.`);
      seen.add(id);
      const assessment = byId.get(id);
      if (
        assessment === undefined ||
        assessment.claimId !== decision.claimId ||
        assessment.validationStatus !== "validated" ||
        assessment.relation !== relation
      ) {
        throw new Error(
          `Decision ${decision.claimId} has an invalid ${relation} assessment reference: ${id}.`,
        );
      }
    }
  }
}

export type ScoreResult = StageResult<ScoreReportV2Data>;
