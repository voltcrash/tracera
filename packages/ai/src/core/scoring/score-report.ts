import {
  CORE_V2_RESOLUTION_COVERAGE_THRESHOLD,
  CORE_V2_SCORE_FORMULA_VERSION,
  claimSchema,
  decisionSchema,
  evidenceAssessmentSchema,
  inputCoverageSchema,
  instantSchema,
  provenanceGraphSchema,
  scorecardSchema,
  type ClaimLabel,
  type ClaimV2,
  type CoreIssue,
  type ScoreNullReason,
  type Scorecard,
  type StageResult,
} from "@repo/contracts/core-v2";
import { buildPresentationFindings } from "../framing/index.js";
import type { ScoreReportV2, ScoreReportV2Data } from "../types.js";

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
    uniqueById(assessments, "assessment");
    uniqueByClaimId(graphs);

    for (const claim of claims) {
      if (claim.parentClaimId !== null) requireClaimLink(claimById, claim, claim.parentClaimId);
      if (claim.duplicateOfClaimId !== null)
        requireClaimLink(claimById, claim, claim.duplicateOfClaimId);
    }

    for (const assessment of assessments) requireClaim(claimById, assessment.claimId);
    validateDecisionReferences(decisions, assessments);
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

    const eligible = canonicalFactual.filter((claim) => decisionByClaim.has(claim.id));
    const omittedClaims = canonicalFactual.length - eligible.length;
    const deferredClaims = claims.filter(
      (claim) => claim.duplicateOfClaimId === null && claim.coverageDisposition === "deferred",
    ).length;
    const counts = verdictCounts(decisions);
    const resolved = counts.supported + counts.contradicted;
    const resolutionCoverage = eligible.length === 0 ? null : resolved / eligible.length;
    const materialMixedOrMisleadingOpen = eligible.some((claim) => {
      const label = decisionByClaim.get(claim.id)!.publishedLabel;
      return claim.material && (label === "mixed" || label === "misleading");
    });
    const nullReasons = scoreNullReasons({
      eligibleFactualClaims: eligible.length,
      resolved,
      resolutionCoverage,
      inputStatus: input.inputStatus,
      extractionStatus: input.extractionStatus,
      materialMixedOrMisleadingOpen,
    });
    const presentationFindings = buildPresentationFindings({
      claims,
      decisions,
      assessments,
    });
    const scorecard = scorecardSchema.parse({
      formulaVersion: CORE_V2_SCORE_FORMULA_VERSION,
      factualScore: nullReasons.length === 0 ? (100 * counts.supported) / resolved : null,
      nullReasons,
      counts: {
        ...counts,
        eligibleFactualClaims: eligible.length,
        deferredClaims,
        omittedClaims,
      },
      resolutionCoverage,
      extractionCoverage: extractionCoverage(coverage),
      inputStatus: input.inputStatus,
      extractionStatus: input.extractionStatus,
      materialMixedOrMisleadingOpen,
      evidence: evidenceSummary(assessments),
      origin: originSummary(graphs),
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
  if (input.materialMixedOrMisleadingOpen) reasons.push("material_mixed_or_misleading_open");
  return reasons;
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
    const references: ReadonlyArray<readonly [string, "supports" | "contradicts" | "context"]> = [
      ...decision.supportingAssessmentIds.map((id) => [id, "supports"] as const),
      ...decision.contradictingAssessmentIds.map((id) => [id, "contradicts"] as const),
      ...decision.correctiveContextAssessmentIds.map((id) => [id, "context"] as const),
    ];
    for (const [id, relation] of references) {
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
