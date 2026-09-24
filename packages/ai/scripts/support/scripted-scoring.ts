import type { ClaimLabel, ClaimV2, Decision, EvidenceAssessment } from "@repo/contracts/core-v2";
import {
  adjudicationAssessment,
  adjudicationClaim,
  adjudicationSnapshot,
} from "./scripted-adjudication.js";

export function scoringClaim(overrides: Partial<ClaimV2> = {}) {
  return adjudicationClaim(overrides);
}

export function scoringAssessment(
  claim: ClaimV2,
  id: string,
  relation: EvidenceAssessment["relation"],
  overrides: Partial<EvidenceAssessment> = {},
) {
  const snapshot = adjudicationSnapshot(id, `Record ${id} supplies assessed context.`);
  return adjudicationAssessment(snapshot, {
    id: `assessment_${id}`,
    claimId: claim.id,
    relation,
    ...overrides,
  });
}

export function scoringDecision(
  claim: ClaimV2,
  publishedLabel: ClaimLabel,
  assessments: EvidenceAssessment[] = [],
): Decision {
  const supportingAssessmentIds = assessments
    .filter(({ relation }) => relation === "supports")
    .map(({ id }) => id);
  const contradictingAssessmentIds = assessments
    .filter(({ relation }) => relation === "contradicts")
    .map(({ id }) => id);
  const correctiveContextAssessmentIds = assessments
    .filter(({ relation }) => relation === "context")
    .map(({ id }) => id);
  const decisive =
    publishedLabel === "supported" ||
    publishedLabel === "contradicted" ||
    publishedLabel === "misleading";
  return {
    claimId: claim.id,
    diagnosticLabel: publishedLabel,
    publishedLabel: decisive ? "unverified" : publishedLabel,
    reasonCodes:
      publishedLabel === "supported"
        ? ["supported_by_admissible_evidence"]
        : publishedLabel === "contradicted"
          ? ["contradicted_by_admissible_evidence"]
          : publishedLabel === "misleading"
            ? ["material_distortion_with_corrective_context"]
            : publishedLabel === "mixed"
              ? ["unresolved_material_conflict"]
              : ["no_admissible_evidence"],
    supportingAssessmentIds,
    contradictingAssessmentIds,
    correctiveContextAssessmentIds,
    justification: "Synthetic scoring fixture decision.",
    challenge: decisive
      ? {
          status: "resolved",
          independentLabel: publishedLabel,
          agreed: true,
          targetedRoundsUsed: 0,
          notes: "Synthetic resolved challenge.",
        }
      : {
          status: publishedLabel === "mixed" ? "unresolved" : "not_required",
          independentLabel: publishedLabel === "mixed" ? "mixed" : null,
          agreed: publishedLabel === "mixed" ? false : null,
          targetedRoundsUsed: 0,
          notes: "No decisive released label.",
        },
    calibration: {
      applicability: "unavailable",
      calibratedCorrectness: null,
      calibratorVersion: null,
      reason: "Focused fixture does not use calibration.",
    },
    rawModelConfidence: null,
    citationIntegrity: decisive ? "valid" : "not_checked",
  };
}
