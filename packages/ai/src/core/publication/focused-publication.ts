import {
  CORE_V2_FOCUSED_NON_CALIBRATION_REASON,
  CORE_V2_FOCUSED_PUBLICATION_DECISION_VERSION,
  CORE_V2_FOCUSED_PUBLICATION_POLICY_VERSION,
  CORE_V2_FOCUSED_SCORE_FORMULA_VERSION,
  claimSchema,
  decisionSchema,
  documentSnapshotSchema,
  evidenceAssessmentSchema,
  focusedPublicationPolicySchema,
  type Calibration,
  type ClaimLabel,
  type ClaimV2,
  type CoreIssue,
  type Decision,
  type DecisionReasonCode,
  type DocumentSnapshot,
  type EvidenceAssessment,
  type FocusedPublicationGate,
  type FocusedPublicationPolicy,
} from "@repo/contracts/core-v2";
import {
  hasSufficientOrigins,
  integrityError,
  isAdjudicable,
  partitionEvidence,
  scopeAbstention,
  withRelation,
} from "../adjudication/policy";
import type {
  FocusedPublicationV2,
  FocusedPublicationV2Data,
  FocusedPublicationV2Input,
  RunEnvironment,
  StageResult,
} from "../types";

export const FOCUSED_PUBLICATION_POLICY: FocusedPublicationPolicy =
  focusedPublicationPolicySchema.parse({
    policyVersion: CORE_V2_FOCUSED_PUBLICATION_POLICY_VERSION,
    decisionVersion: CORE_V2_FOCUSED_PUBLICATION_DECISION_VERSION,
    mode: "evidence_gated",
    scoreFormulaVersion: CORE_V2_FOCUSED_SCORE_FORMULA_VERSION,
    calibration: {
      status: "not_used",
      probability: null,
      reason: CORE_V2_FOCUSED_NON_CALIBRATION_REASON,
    },
  });

const FOCUSED_CALIBRATION: Calibration = {
  applicability: "unavailable",
  calibratedCorrectness: null,
  calibratorVersion: null,
  reason: CORE_V2_FOCUSED_NON_CALIBRATION_REASON,
};

const CALIBRATION_REASONS = new Set<DecisionReasonCode>([
  "calibration_unavailable",
  "calibration_out_of_scope",
]);

type CitationStatus =
  | { status: "valid"; cited: CitationSets }
  | { status: "invalid"; reason: string }
  | { status: "failed_applicability"; reason: string };

interface CitationSets {
  supporting: EvidenceAssessment[];
  contradicting: EvidenceAssessment[];
  corrective: EvidenceAssessment[];
}

interface PublicationEvaluation {
  label: ClaimLabel;
  gate: FocusedPublicationGate;
  citationIntegrity: Decision["citationIntegrity"];
  supporting: string[];
  contradicting: string[];
  corrective: string[];
  challenge: Decision["challenge"];
  reasonCodes: DecisionReasonCode[];
  issue: CoreIssue | null;
}

/**
 * Pure focused publication policy. It only reads the supplied immutable artifacts and makes
 * no model, search, acquisition, clock, or storage calls.
 */
export function publishFocusedDecisions(
  input: FocusedPublicationV2Input,
): FocusedPublicationV2Data & {
  issues: CoreIssue[];
} {
  const claims = input.claims.map((claim) => claimSchema.parse(claim));
  const snapshots = input.snapshots.map((snapshot) => documentSnapshotSchema.parse(snapshot));
  const assessments = input.assessments.map((assessment) =>
    evidenceAssessmentSchema.parse(assessment),
  );
  const decisions = input.decisions.map((decision) => decisionSchema.parse(decision));
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const assessmentsByClaim = new Map<string, EvidenceAssessment[]>();
  for (const assessment of assessments) {
    const existing = assessmentsByClaim.get(assessment.claimId) ?? [];
    existing.push(assessment);
    assessmentsByClaim.set(assessment.claimId, existing);
  }

  const issues: CoreIssue[] = [];
  const published = decisions.flatMap((decision) => {
    const claim = claimsById.get(decision.claimId);
    if (claim === undefined) {
      issues.push(
        publicationIssue(
          "citation_validation_failed",
          "Focused publication rejected a decision for an unknown claim.",
          decision.claimId,
        ),
      );
      return [];
    }
    const claimAssessments = assessmentsByClaim.get(claim.id) ?? [];
    const evaluation = evaluateDecision(claim, decision, claimAssessments, snapshotsById);
    if (evaluation.issue !== null) issues.push(evaluation.issue);
    return [
      decisionSchema.parse({
        ...decision,
        publishedLabel: evaluation.label,
        reasonCodes: unique(evaluation.reasonCodes),
        supportingAssessmentIds: evaluation.supporting,
        contradictingAssessmentIds: evaluation.contradicting,
        correctiveContextAssessmentIds: evaluation.corrective,
        challenge: evaluation.challenge,
        calibration: FOCUSED_CALIBRATION,
        focusedPublication: {
          policyVersion: FOCUSED_PUBLICATION_POLICY.policyVersion,
          decisionVersion: FOCUSED_PUBLICATION_POLICY.decisionVersion,
          status: evaluation.gate === "passed" ? "published" : "abstained",
          gate: evaluation.gate,
          calibration: FOCUSED_PUBLICATION_POLICY.calibration,
        },
        citationIntegrity: evaluation.citationIntegrity,
      }),
    ];
  });

  return { policy: FOCUSED_PUBLICATION_POLICY, decisions: published, issues };
}

/** Local publication stage adapter. It has zero provider requests by construction. */
export function createFocusedPublicationV2(): FocusedPublicationV2 {
  return async (input, environment) => {
    const { clock } = environment.ports;
    const startedAt = clock.now();
    const startedMs = clock.monotonicMs();
    await audit(environment, "stage_started", "Focused evidence publication started.", null);
    if (canceled(environment)) {
      const issue = publicationIssue(
        "cancellation_requested",
        "Focused evidence publication was canceled before the local gate ran.",
        null,
      );
      await audit(environment, "cancellation", issue.message, null);
      return finish("failed", null, [issue]);
    }

    try {
      const published = publishFocusedDecisions(input);
      const data: FocusedPublicationV2Data = {
        policy: published.policy,
        decisions: published.decisions,
      };
      for (const decision of published.decisions) {
        const gate = decision.focusedPublication?.gate;
        if (gate !== "passed") {
          await audit(
            environment,
            "decision_gated",
            `Focused evidence gate abstained for ${decision.diagnosticLabel}: ${gate ?? "unknown"}.`,
            decision.claimId,
          );
        }
      }
      if (canceled(environment)) {
        const issue = publicationIssue(
          "cancellation_requested",
          "Focused evidence publication was canceled before it returned its local decisions.",
          null,
        );
        await audit(environment, "cancellation", issue.message, null);
        return finish("failed", null, [issue]);
      }
      const status = published.issues.length === 0 ? "complete" : "partial";
      await audit(
        environment,
        "stage_finished",
        `Focused evidence publication finished with status ${status}.`,
        null,
      );
      return {
        status,
        data,
        issues: published.issues,
        metrics: metrics(startedAt, clock.now(), startedMs, clock.monotonicMs()),
      };
    } catch (error) {
      const issue = publicationIssue(
        "citation_validation_failed",
        `Focused publication input was rejected: ${error instanceof Error ? error.message : "unknown error"}`,
        null,
      );
      await audit(environment, "validation_rejected", issue.message, null);
      await audit(
        environment,
        "stage_finished",
        "Focused evidence publication finished with status failed.",
        null,
      );
      return finish("failed", null, [issue]);
    }

    function finish(
      status: StageResult<FocusedPublicationV2Data>["status"],
      data: FocusedPublicationV2Data | null,
      issues: CoreIssue[],
    ): StageResult<FocusedPublicationV2Data> {
      return {
        status,
        data,
        issues,
        metrics: metrics(startedAt, clock.now(), startedMs, clock.monotonicMs()),
      };
    }
  };
}

function evaluateDecision(
  claim: ClaimV2,
  decision: Decision,
  claimAssessments: EvidenceAssessment[],
  snapshots: Map<string, DocumentSnapshot>,
): PublicationEvaluation {
  const baseReasons = decision.reasonCodes.filter((code) => !CALIBRATION_REASONS.has(code));
  const partition = partitionEvidence(claim, claimAssessments, snapshots);
  const citation = validateCitations(decision, claimAssessments, snapshots);
  const issueFor = (code: CoreIssue["code"], message: string, snapshotId: string | null = null) =>
    publicationIssue(code, message, claim.id, snapshotId);
  const abstain = (
    gate: FocusedPublicationGate,
    reasonCodes: DecisionReasonCode[],
    message: string,
    citationIntegrity: Decision["citationIntegrity"] = citation.status === "invalid"
      ? "invalid"
      : decision.citationIntegrity,
    labels: Partial<
      Pick<PublicationEvaluation, "supporting" | "contradicting" | "corrective">
    > = {},
    challenge = decision.challenge,
  ): PublicationEvaluation => ({
    label: "unverified",
    gate,
    citationIntegrity,
    supporting:
      labels.supporting ??
      (citation.status === "valid" ? citation.cited.supporting.map(({ id }) => id) : []),
    contradicting:
      labels.contradicting ??
      (citation.status === "valid" ? citation.cited.contradicting.map(({ id }) => id) : []),
    corrective:
      labels.corrective ??
      (citation.status === "valid" ? citation.cited.corrective.map(({ id }) => id) : []),
    challenge,
    reasonCodes: unique([...baseReasons, ...reasonCodes, "focused_evidence_gate_abstained"]),
    issue:
      gate === "invalid_citation"
        ? issueFor("citation_validation_failed", message)
        : gate === "failed_applicability"
          ? issueFor("citation_validation_failed", message)
          : null,
  });

  const scope = scopeAbstention(claim);
  if (!isAdjudicable(claim) || scope !== null)
    return abstain(
      "ambiguous_scope",
      scope ?? ["no_checkable_proposition"],
      "The focused publication gate could not establish a checkable claim scope.",
    );

  if (partition.integrityFailures.length > 0 || citation.status === "invalid")
    return abstain(
      "invalid_citation",
      ["citation_validation_failed"],
      citation.status === "invalid"
        ? citation.reason
        : "At least one evidence assessment failed immutable citation validation.",
      "invalid",
    );
  if (citation.status === "failed_applicability")
    return abstain(
      "failed_applicability",
      applicabilityReasons(claimAssessments, decision),
      citation.reason,
      decision.citationIntegrity === "invalid" ? "invalid" : "valid",
    );

  const usable = partition.usable;
  const supports = withRelation(usable, "supports");
  const contradicts = withRelation(usable, "contradicts");
  const corrective = withRelation(usable, "context");
  const bothSidesSufficient =
    claim.material && hasSufficientOrigins(supports) && hasSufficientOrigins(contradicts);
  if (bothSidesSufficient) {
    return {
      label: "mixed",
      gate: "unresolved_conflict",
      citationIntegrity: "valid",
      supporting: supports.map(({ id }) => id),
      contradicting: contradicts.map(({ id }) => id),
      corrective: validReferencedIds(decision.correctiveContextAssessmentIds, corrective),
      challenge: unresolvedChallenge(decision),
      reasonCodes: unique([
        ...baseReasons,
        "unresolved_material_conflict",
        "focused_evidence_gate_abstained",
      ]),
      issue: null,
    };
  }

  const cited = citation.cited;
  const citedSupporting = cited.supporting;
  const citedContradicting = cited.contradicting;
  const citedCorrective = cited.corrective;
  const originalLabel = decision.diagnosticLabel;

  if (originalLabel === "mixed") {
    if (
      supports.length > 0 &&
      contradicts.length > 0 &&
      claim.material &&
      hasSufficientOrigins(supports) &&
      hasSufficientOrigins(contradicts)
    ) {
      return {
        label: "mixed",
        gate: "unresolved_conflict",
        citationIntegrity: "valid",
        supporting: supports.map(({ id }) => id),
        contradicting: contradicts.map(({ id }) => id),
        corrective: citedCorrective.map(({ id }) => id),
        challenge: decision.challenge,
        reasonCodes: unique([
          ...baseReasons,
          "unresolved_material_conflict",
          "focused_evidence_gate_abstained",
        ]),
        issue: null,
      };
    }
    return abstain(
      "insufficient_evidence",
      ["insufficient_independent_origins"],
      "Applicable evidence did not establish both sides of the unresolved focused conflict.",
      "valid",
    );
  }

  if (originalLabel === "unverified") {
    return abstain(
      unverifiedGate(decision, usable),
      unverifiedReasons(decision, usable),
      "The focused evidence gate could not establish a publishable claim label.",
      decision.citationIntegrity,
    );
  }

  const shape = shapeValid(
    originalLabel,
    citedSupporting,
    citedContradicting,
    citedCorrective,
    claim,
  );
  if (!shape.valid)
    return abstain("invalid_citation", ["citation_validation_failed"], shape.reason, "invalid");

  const sufficient =
    originalLabel === "supported"
      ? hasSufficientOrigins(citedSupporting)
      : originalLabel === "contradicted"
        ? hasSufficientOrigins(citedContradicting)
        : hasSufficientOrigins(citedCorrective) && hasSufficientOrigins(citedSupporting);
  if (!sufficient)
    return abstain(
      "insufficient_evidence",
      ["insufficient_independent_origins"],
      "The cited evidence does not meet the focused independent-origin requirement.",
      "valid",
    );

  const opposing = originalLabel === "contradicted" ? supports : contradicts;
  if (opposing.length > 0)
    return abstain(
      "unresolved_conflict",
      ["unresolved_material_conflict"],
      "Applicable evidence supports and contradicts the scoped claim; the conflict remains explicit.",
      "valid",
      {
        supporting: supports.map(({ id }) => id),
        contradicting: contradicts.map(({ id }) => id),
        corrective: citedCorrective.map(({ id }) => id),
      },
      unresolvedChallenge(decision),
    );

  if (
    decision.challenge.status !== "resolved" ||
    decision.challenge.agreed !== true ||
    decision.challenge.independentLabel !== originalLabel
  )
    return abstain(
      "challenge_unresolved",
      ["unresolved_challenge_disagreement"],
      "The label-blind challenge did not resolve in agreement with the decisive label.",
      "valid",
    );

  return {
    label: originalLabel,
    gate: "passed",
    citationIntegrity: "valid",
    supporting: citedSupporting.map(({ id }) => id),
    contradicting: citedContradicting.map(({ id }) => id),
    corrective: citedCorrective.map(({ id }) => id),
    challenge: decision.challenge,
    reasonCodes: baseReasons.length > 0 ? baseReasons : defaultReason(originalLabel),
    issue: null,
  };
}

function validateCitations(
  decision: Decision,
  assessments: EvidenceAssessment[],
  snapshots: Map<string, DocumentSnapshot>,
): CitationStatus {
  const byId = new Map(assessments.map((assessment) => [assessment.id, assessment]));
  const seen = new Set<string>();
  const cited: CitationSets = { supporting: [], contradicting: [], corrective: [] };
  const roles: Array<[keyof CitationSets, string[], EvidenceAssessment["relation"]]> = [
    ["supporting", decision.supportingAssessmentIds, "supports"],
    ["contradicting", decision.contradictingAssessmentIds, "contradicts"],
    ["corrective", decision.correctiveContextAssessmentIds, "context"],
  ];
  for (const [key, ids, relation] of roles) {
    for (const id of ids) {
      if (seen.has(id)) return { status: "invalid", reason: `Assessment ${id} was cited twice.` };
      seen.add(id);
      const assessment = byId.get(id);
      if (assessment === undefined)
        return {
          status: "invalid",
          reason: `Assessment ${id} is not present in the focused evidence set.`,
        };
      if (assessment.claimId !== decision.claimId)
        return { status: "invalid", reason: `Assessment ${id} belongs to another claim.` };
      if (assessment.relation !== relation)
        return {
          status: "invalid",
          reason: `Assessment ${id} does not have relation ${relation}.`,
        };
      const error = focusedIntegrityError(assessment, snapshots);
      if (error !== null) return { status: "invalid", reason: `Assessment ${id}: ${error}.` };
      if (assessment.validationStatus !== "validated")
        return { status: "invalid", reason: `Assessment ${id} is not validated.` };
      if (snapshots.get(assessment.snapshotId)?.role === "submitted_input")
        return {
          status: "invalid",
          reason: `Assessment ${id} cites the submitted input as evidence.`,
        };
      if (Object.values(assessment.applicability).some((value) => value !== "applicable"))
        return {
          status: "failed_applicability",
          reason: `Assessment ${id} failed a focused applicability check.`,
        };
      if (assessment.checks.some(({ result }) => result === "fail"))
        return {
          status: "invalid",
          reason: `Assessment ${id} contains a failed validation check.`,
        };
      if (
        !assessment.checks.some(
          ({ check, result }) => check === "quote_offsets" && result === "pass",
        )
      )
        return { status: "invalid", reason: `Assessment ${id} lacks a passing exact-quote check.` };
      cited[key].push(assessment);
    }
  }
  if (seen.size > 0 && decision.citationIntegrity !== "valid")
    return { status: "invalid", reason: "The decision did not mark its cited evidence as valid." };
  return { status: "valid", cited };
}

function focusedIntegrityError(
  assessment: EvidenceAssessment,
  snapshots: Map<string, DocumentSnapshot>,
): string | null {
  const error = integrityError(assessment, snapshots);
  if (error !== null) return error;
  const snapshot = snapshots.get(assessment.snapshotId);
  if (snapshot === undefined) return `references unavailable snapshot ${assessment.snapshotId}`;
  if (assessment.excerpt.span.end > snapshot.normalizedText.length)
    return "excerpt offsets exceed the immutable snapshot text length";
  for (const locator of assessment.dependenceLocators) {
    const target = snapshots.get(locator.snapshotId);
    if (target !== undefined && locator.span.end > target.normalizedText.length)
      return "a dependence locator exceeds its immutable snapshot text length";
  }
  return null;
}

function shapeValid(
  label: Extract<ClaimLabel, "supported" | "contradicted" | "misleading">,
  supporting: EvidenceAssessment[],
  contradicting: EvidenceAssessment[],
  corrective: EvidenceAssessment[],
  claim: ClaimV2,
): { valid: true } | { valid: false; reason: string } {
  const valid = {
    supported: supporting.length > 0 && contradicting.length === 0 && corrective.length === 0,
    contradicted: contradicting.length > 0 && supporting.length === 0 && corrective.length === 0,
    misleading:
      claim.material &&
      supporting.length > 0 &&
      corrective.length > 0 &&
      contradicting.length === 0,
  }[label];
  return valid
    ? { valid: true }
    : {
        valid: false,
        reason: `The cited evidence roles do not satisfy the ${label} focused policy.`,
      };
}

function validReferencedIds(ids: string[], assessments: EvidenceAssessment[]) {
  const valid = new Set(assessments.map(({ id }) => id));
  return ids.filter((id) => valid.has(id));
}

function unresolvedChallenge(decision: Decision): Decision["challenge"] {
  return {
    ...decision.challenge,
    status: "unresolved",
    agreed: false,
    notes:
      "Applicable support and contradiction remain unresolved under the focused evidence gate.",
  };
}

function unverifiedGate(decision: Decision, usable: EvidenceAssessment[]): FocusedPublicationGate {
  if (
    decision.reasonCodes.includes("ambiguous_claim_scope") ||
    decision.reasonCodes.includes("unresolved_context")
  )
    return "ambiguous_scope";
  if (
    decision.reasonCodes.includes("source_unavailable") ||
    decision.reasonCodes.includes("unsupported_language")
  )
    return "evidence_unavailable";
  if (decision.reasonCodes.includes("awaiting_deferred_processing")) return "uncertain_evidence";
  if (usable.length === 0) return "evidence_unavailable";
  return "insufficient_evidence";
}

function unverifiedReasons(decision: Decision, usable: EvidenceAssessment[]): DecisionReasonCode[] {
  const reasons = decision.reasonCodes.filter((code) => !CALIBRATION_REASONS.has(code));
  if (reasons.length > 0) return reasons;
  return usable.length === 0 ? ["no_admissible_evidence"] : ["insufficient_independent_origins"];
}

function applicabilityReasons(
  assessments: EvidenceAssessment[],
  decision: Decision,
): DecisionReasonCode[] {
  const ids = new Set([
    ...decision.supportingAssessmentIds,
    ...decision.contradictingAssessmentIds,
    ...decision.correctiveContextAssessmentIds,
  ]);
  const reasons: DecisionReasonCode[] = [];
  for (const assessment of assessments) {
    if (!ids.has(assessment.id)) continue;
    if (assessment.applicability.temporal !== "applicable")
      reasons.push("evidence_not_applicable_in_time");
    if (assessment.applicability.entity !== "applicable")
      reasons.push("evidence_not_applicable_to_entity");
    if (assessment.applicability.jurisdiction !== "applicable")
      reasons.push("evidence_not_applicable_in_jurisdiction");
  }
  return reasons.length > 0 ? reasons : ["citation_validation_failed"];
}

function defaultReason(label: Extract<ClaimLabel, "supported" | "contradicted" | "misleading">) {
  return [
    label === "supported"
      ? "supported_by_admissible_evidence"
      : label === "contradicted"
        ? "contradicted_by_admissible_evidence"
        : "material_distortion_with_corrective_context",
  ] satisfies DecisionReasonCode[];
}

function publicationIssue(
  code: CoreIssue["code"],
  message: string,
  claimId: string | null,
  snapshotId: string | null = null,
): CoreIssue {
  return { code, severity: "warning", message, claimId, snapshotId, url: null };
}

function metrics(startedAt: string, completedAt: string, startedMs: number, completedMs: number) {
  return {
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedMs - startedMs),
    externalRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

async function audit(
  environment: RunEnvironment,
  kind: Parameters<RunEnvironment["ports"]["audit"]["record"]>[0]["kind"],
  message: string,
  claimId: string | null,
) {
  await environment.ports.audit.record({
    runId: environment.context.runId,
    stage: "calibrate_decisions",
    kind,
    message,
    claimId,
    snapshotId: null,
    at: environment.ports.clock.now(),
  });
}

function canceled(environment: RunEnvironment) {
  return environment.signal.aborted || environment.context.cancellation.requested;
}

function unique<Value>(values: Value[]) {
  return [...new Set(values)];
}
