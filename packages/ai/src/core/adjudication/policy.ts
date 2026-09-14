import {
  decisiveLabels,
  evidenceAssessmentSchema,
  type ClaimLabel,
  type ClaimV2,
  type DecisionReasonCode,
  type DocumentSnapshot,
  type EvidenceAssessment,
  type EvidenceRelation,
} from "@repo/contracts/core-v2";
import type { ChallengeProposal, DraftProposal, EvidencePartition } from "./types.js";

export type DecisiveLabel = (typeof decisiveLabels)[number];

export function isDecisive(label: ClaimLabel): label is DecisiveLabel {
  return (decisiveLabels as readonly string[]).includes(label);
}

export function isAdjudicable(claim: ClaimV2) {
  return claim.duplicateOfClaimId === null && claim.coverageDisposition === "factual_claim";
}

/** Claims whose scope cannot be checked abstain before any evidence or model is consulted. */
export function scopeAbstention(claim: ClaimV2): DecisionReasonCode[] | null {
  if (claim.checkability === "needs_context" || claim.unresolvedContext.length > 0)
    return ["ambiguous_claim_scope", "unresolved_context"];
  if (claim.checkability === "unanswerable") return ["no_admissible_evidence"];
  if (claim.checkability === "not_checkable") return ["no_checkable_proposition"];
  return null;
}

export function integrityError(
  assessment: EvidenceAssessment,
  snapshots: Map<string, DocumentSnapshot>,
): string | null {
  if (!evidenceAssessmentSchema.safeParse(assessment).success)
    return "does not satisfy the frozen assessment schema";
  const snapshot = snapshots.get(assessment.snapshotId);
  if (snapshot === undefined) return `references unavailable snapshot ${assessment.snapshotId}`;
  const { span, quote } = assessment.excerpt;
  if (snapshot.normalizedText.slice(span.start, span.end) !== quote)
    return "excerpt offsets do not reproduce the quoted text";
  for (const locator of assessment.dependenceLocators) {
    const target = snapshots.get(locator.snapshotId);
    if (target?.normalizedText.slice(locator.span.start, locator.span.end) !== locator.quote)
      return "a dependence locator does not reproduce its quoted text";
  }
  if (
    assessment.validationStatus === "validated" &&
    !assessment.checks.some(({ check, result }) => check === "quote_offsets" && result === "pass")
  )
    return "a validated assessment lacks a passing quote-offset check";
  return null;
}

const applicabilityReasons = {
  temporal: "evidence_not_applicable_in_time",
  entity: "evidence_not_applicable_to_entity",
  jurisdiction: "evidence_not_applicable_in_jurisdiction",
} as const satisfies Partial<Record<keyof EvidenceAssessment["applicability"], DecisionReasonCode>>;

const failedCheckReasons: Partial<
  Record<EvidenceAssessment["checks"][number]["check"], DecisionReasonCode>
> = {
  entity_identity: "evidence_not_applicable_to_entity",
  temporal_scope: "evidence_not_applicable_in_time",
  jurisdiction: "evidence_not_applicable_in_jurisdiction",
  quote_offsets: "citation_validation_failed",
  citation_reference: "citation_validation_failed",
};

export function partitionEvidence(
  claim: ClaimV2,
  assessments: EvidenceAssessment[],
  snapshots: Map<string, DocumentSnapshot>,
): EvidencePartition {
  const partition: EvidencePartition = {
    usable: [],
    integrityFailures: [],
    exclusionReasons: new Set(),
    needsHumanReview: 0,
  };
  for (const assessment of assessments.filter(({ claimId }) => claimId === claim.id)) {
    const error = integrityError(assessment, snapshots);
    if (error !== null) {
      partition.integrityFailures.push(`${assessment.id}: ${error}`);
      continue;
    }
    if (assessment.validationStatus === "needs_human_review") {
      partition.needsHumanReview += 1;
      continue;
    }
    if (assessment.validationStatus === "rejected") {
      for (const { check, result } of assessment.checks) {
        const reason = failedCheckReasons[check];
        if (result === "fail" && reason !== undefined) partition.exclusionReasons.add(reason);
      }
      continue;
    }
    // The submitted document cannot corroborate its own assertion.
    if (snapshots.get(assessment.snapshotId)?.role === "submitted_input") continue;
    if (assessment.relation === "irrelevant" || assessment.relation === "insufficient") continue;
    let applicable = true;
    for (const [dimension, value] of Object.entries(assessment.applicability)) {
      if (value === "applicable") continue;
      applicable = false;
      const reason = applicabilityReasons[dimension as keyof typeof applicabilityReasons];
      if (reason !== undefined && value === "not_applicable")
        partition.exclusionReasons.add(reason);
    }
    if (applicable) partition.usable.push(assessment);
  }
  return partition;
}

/** A usable independent primary record, or two established independent origin groups. */
export function hasSufficientOrigins(evidence: EvidenceAssessment[]) {
  const independent = evidence.filter(({ dependence }) => dependence === "independent");
  return (
    independent.some(({ directness }) => directness === "primary") ||
    new Set(independent.map(({ dependencyGroupId }) => dependencyGroupId)).size >= 2
  );
}

export function withRelation(evidence: EvidenceAssessment[], relation: EvidenceRelation) {
  return evidence.filter((assessment) => assessment.relation === relation);
}

export function opposingEvidence(label: DecisiveLabel, usable: EvidenceAssessment[]) {
  return withRelation(usable, label === "contradicted" ? "supports" : "contradicts");
}

export type DraftResolution =
  | { kind: "invalid"; reason: string }
  | {
      kind: "resolved";
      label: ClaimLabel;
      reasonCodes: DecisionReasonCode[];
      supporting: string[];
      contradicting: string[];
      corrective: string[];
    };

export function resolveDraft(
  draft: DraftProposal,
  claim: ClaimV2,
  usable: EvidenceAssessment[],
): DraftResolution {
  if (draft.claimId !== claim.id)
    return { kind: "invalid", reason: "The draft named another claim." };
  const byId = new Map(usable.map((assessment) => [assessment.id, assessment]));
  const roles: Array<[string[], EvidenceRelation]> = [
    [draft.supportingAssessmentIds, "supports"],
    [draft.contradictingAssessmentIds, "contradicts"],
    [draft.correctiveContextAssessmentIds, "context"],
  ];
  const seen = new Set<string>();
  for (const [ids, relation] of roles) {
    for (const id of ids) {
      if (seen.has(id)) return { kind: "invalid", reason: `Assessment ${id} was cited twice.` };
      seen.add(id);
      const assessment = byId.get(id);
      if (assessment === undefined)
        return {
          kind: "invalid",
          reason: `Assessment ${id} is not a validated, applicable, admissible assessment of this claim.`,
        };
      if (assessment.relation !== relation)
        return { kind: "invalid", reason: `Assessment ${id} does not have relation ${relation}.` };
    }
  }
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)!);
  const supporting = pick(draft.supportingAssessmentIds);
  const contradicting = pick(draft.contradictingAssessmentIds);
  const corrective = pick(draft.correctiveContextAssessmentIds);
  const shapeValid = {
    supported: supporting.length > 0 && contradicting.length === 0 && corrective.length === 0,
    contradicted: contradicting.length > 0 && supporting.length === 0 && corrective.length === 0,
    misleading: supporting.length > 0 && corrective.length > 0 && contradicting.length === 0,
    mixed: supporting.length > 0 && contradicting.length > 0,
    unverified: true,
  }[draft.label];
  if (!shapeValid)
    return {
      kind: "invalid",
      reason: `The cited evidence roles do not satisfy the ${draft.label} policy.`,
    };

  const resolved = (label: ClaimLabel, reasonCodes: DecisionReasonCode[]): DraftResolution => ({
    kind: "resolved",
    label,
    reasonCodes,
    supporting: draft.supportingAssessmentIds,
    contradicting: draft.contradictingAssessmentIds,
    corrective: draft.correctiveContextAssessmentIds,
  });
  switch (draft.label) {
    case "supported":
      return hasSufficientOrigins(supporting)
        ? resolved("supported", ["supported_by_admissible_evidence"])
        : resolved("unverified", ["insufficient_independent_origins"]);
    case "contradicted":
      return hasSufficientOrigins(contradicting)
        ? resolved("contradicted", ["contradicted_by_admissible_evidence"])
        : resolved("unverified", ["insufficient_independent_origins"]);
    case "misleading":
      return hasSufficientOrigins(corrective)
        ? resolved("misleading", ["material_distortion_with_corrective_context"])
        : resolved("unverified", ["insufficient_independent_origins"]);
    case "mixed":
      return claim.material
        ? resolved("mixed", ["unresolved_material_conflict"])
        : resolved("unverified", ["unresolved_material_conflict"]);
    case "unverified":
      return resolved(
        "unverified",
        hasSufficientOrigins(withRelation(usable, "supports")) ||
          hasSufficientOrigins(withRelation(usable, "contradicts"))
          ? ["ambiguous_claim_scope"]
          : ["insufficient_independent_origins"],
      );
  }
}

export function validateChallenge(
  proposal: ChallengeProposal,
  claim: ClaimV2,
  usable: EvidenceAssessment[],
): { valid: true; label: ClaimLabel } | { valid: false; reason: string } {
  if (proposal.claimId !== claim.id)
    return { valid: false, reason: "The challenge named another claim." };
  const byId = new Map(usable.map((assessment) => [assessment.id, assessment]));
  const cited: EvidenceAssessment[] = [];
  for (const id of proposal.citedAssessmentIds) {
    const assessment = byId.get(id);
    if (assessment === undefined)
      return { valid: false, reason: `The challenge cited unusable assessment ${id}.` };
    cited.push(assessment);
  }
  const has = (relation: EvidenceRelation) => cited.some((item) => item.relation === relation);
  const consistent = {
    supported: has("supports"),
    contradicted: has("contradicts"),
    misleading: has("supports") && has("context"),
    mixed: has("supports") && has("contradicts"),
    unverified: true,
  }[proposal.label];
  return consistent
    ? { valid: true, label: proposal.label }
    : {
        valid: false,
        reason: `The challenge label ${proposal.label} is not backed by its cited evidence.`,
      };
}
