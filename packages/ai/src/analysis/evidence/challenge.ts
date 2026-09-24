import type { Claim, EvidenceAssessment } from "@repo/contracts/analysis";
import type { ChallengeInput } from "./types";

export function buildChallengeInput(
  claim: Claim,
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
