import type { ClaimV2, EvidenceAssessment } from "@repo/contracts/core-v2";
import type { ChallengeInput } from "./types.js";

export function buildChallengeInput(
  claim: ClaimV2,
  assessments: EvidenceAssessment[],
): ChallengeInput {
  return {
    claim,
    evidence: assessments
      .filter(
        (assessment) =>
          assessment.claimId === claim.id &&
          assessment.validationStatus === "validated" &&
          Object.values(assessment.applicability).every((value) => value === "applicable"),
      )
      .map(
        ({
          id,
          snapshotId,
          excerpt,
          relation,
          applicability,
          directness,
          dependencyGroupId,
          dependence,
          justification,
        }) => ({
          id,
          snapshotId,
          excerpt,
          relation,
          applicability,
          directness,
          dependencyGroupId,
          dependence,
          justification,
        }),
      ),
  };
}
