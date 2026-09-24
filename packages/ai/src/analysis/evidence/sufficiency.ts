import type { Claim, EvidenceAssessment, SufficiencyFeedback } from "@repo/contracts/analysis";

export function buildSufficiencyFeedback(
  claims: Claim[],
  assessments: EvidenceAssessment[],
): SufficiencyFeedback[] {
  return claims
    .filter(
      (claim) => claim.duplicateOfClaimId === null && claim.coverageDisposition === "factual_claim",
    )
    .map((claim) => {
      const relevant = assessments.filter(
        (assessment) =>
          assessment.claimId === claim.id &&
          assessment.validationStatus === "validated" &&
          assessment.relation !== "irrelevant" &&
          assessment.relation !== "insufficient",
      );
      const applicable = relevant.filter((assessment) =>
        Object.values(assessment.applicability).every((value) => value === "applicable"),
      );
      const independentGroups = new Set(
        applicable
          .filter((assessment) => assessment.dependence === "independent")
          .map((assessment) => assessment.dependencyGroupId),
      );
      const unknownGroups = new Set(
        relevant
          .filter((assessment) => assessment.dependence === "unknown")
          .map((assessment) => assessment.dependencyGroupId),
      );
      const hasPrimary = applicable.some(
        (assessment) =>
          assessment.directness === "primary" && assessment.dependence === "independent",
      );
      const hasDisconfirming = applicable.some(
        (assessment) => assessment.relation === "contradicts",
      );
      const missing = new Set<SufficiencyFeedback["missing"][number]>();
      if (!hasPrimary) missing.add("primary_record");
      if (!hasDisconfirming) missing.add("disconfirming_evidence");
      if (independentGroups.size === 0) missing.add("independent_origin");
      if (relevant.some((assessment) => assessment.applicability.temporal !== "applicable")) {
        missing.add("time_applicable_evidence");
      }
      if (relevant.some((assessment) => assessment.applicability.jurisdiction !== "applicable")) {
        missing.add("jurisdiction_applicable_evidence");
      }
      if (
        claim.quantities.length > 0 &&
        !relevant.some((assessment) => assessment.calculation !== null)
      ) {
        missing.add("numeric_operands");
      }
      if (relevant.length === 0) missing.add("full_document_acquisition");
      const sufficient =
        claim.checkability === "checkable" &&
        applicable.length > 0 &&
        (hasPrimary || independentGroups.size >= 2);
      return {
        claimId: claim.id,
        sufficient,
        missing: sufficient ? [] : [...missing],
        suggestedQueries: sufficient
          ? []
          : [...missing].map((reason) => ({
              query: `${claim.text} ${querySuffix(reason)}`,
              intent: intent(reason),
            })),
        independentOriginCount: independentGroups.size,
        unknownDependenceCount: unknownGroups.size,
      };
    });
}

function querySuffix(reason: SufficiencyFeedback["missing"][number]) {
  const suffixes: Record<SufficiencyFeedback["missing"][number], string> = {
    primary_record: "official primary record",
    disconfirming_evidence: "contrary evidence",
    independent_origin: "independent source",
    time_applicable_evidence: "date-specific evidence",
    jurisdiction_applicable_evidence: "jurisdiction official record",
    numeric_operands: "underlying data denominator",
    full_document_acquisition: "full original document",
  };
  return suffixes[reason];
}

function intent(reason: SufficiencyFeedback["missing"][number]) {
  if (reason === "disconfirming_evidence") return "disconfirming" as const;
  if (reason === "primary_record") return "primary_source" as const;
  if (reason === "time_applicable_evidence") return "date_constrained" as const;
  return "neutral" as const;
}
