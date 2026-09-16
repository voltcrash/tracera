import { z } from "zod";
import type { Decision, EvidenceAssessment } from "@repo/contracts/core-v2";
import { isDecisive } from "../adjudication/policy";

export const CALIBRATION_FEATURE_VERSION = "core-v2-calibration-features-1.0.0";

export const CALIBRATION_FEATURE_NAMES = [
  "label_supported",
  "label_contradicted",
  "label_misleading",
  "cited_assessments_log1p",
  "independent_origin_groups",
  "unknown_dependence_groups",
  "primary_directness_share",
  "scope_checks_all_pass",
  "opposing_applicable_assessments",
  "challenge_agreed",
  "targeted_rounds_used",
  "raw_confidence_present",
  "raw_confidence",
] as const;

export type CalibrationFeatureName = (typeof CALIBRATION_FEATURE_NAMES)[number];
export type CalibrationFeatures = Record<CalibrationFeatureName, number>;

export const calibrationFeaturesSchema = z.strictObject(
  Object.fromEntries(
    CALIBRATION_FEATURE_NAMES.map((name) => [name, z.number().finite()]),
  ) as Record<CalibrationFeatureName, z.ZodNumber>,
);

export class CalibrationFeatureError extends Error {}

/**
 * Features describe the adjudicated evidence, not the proposition: applicability and
 * directness, dependency-group counts, scope checks, challenge outcome and the model's
 * uncalibrated self-score when one exists.
 */
export function extractCalibrationFeatures(
  decision: Decision,
  assessments: EvidenceAssessment[],
): CalibrationFeatures {
  if (!isDecisive(decision.diagnosticLabel))
    throw new CalibrationFeatureError("Correctness calibration covers decisive labels only.");
  const byId = new Map(assessments.map((assessment) => [assessment.id, assessment]));
  const cited = [
    ...decision.supportingAssessmentIds,
    ...decision.contradictingAssessmentIds,
    ...decision.correctiveContextAssessmentIds,
  ].map((id) => {
    const assessment = byId.get(id);
    if (
      assessment === undefined ||
      assessment.claimId !== decision.claimId ||
      assessment.validationStatus !== "validated"
    )
      throw new CalibrationFeatureError(
        `Cited assessment ${id} is not a validated assessment of the claim.`,
      );
    return assessment;
  });
  if (cited.length === 0)
    throw new CalibrationFeatureError("A decisive decision must cite evidence.");
  const opposingRelation = decision.diagnosticLabel === "contradicted" ? "supports" : "contradicts";
  const opposing = assessments.filter(
    (assessment) =>
      assessment.claimId === decision.claimId &&
      assessment.validationStatus === "validated" &&
      assessment.relation === opposingRelation &&
      Object.values(assessment.applicability).every((value) => value === "applicable"),
  );
  const groups = (dependence: EvidenceAssessment["dependence"]) =>
    new Set(
      cited.filter((item) => item.dependence === dependence).map((item) => item.dependencyGroupId),
    ).size;
  return {
    label_supported: Number(decision.diagnosticLabel === "supported"),
    label_contradicted: Number(decision.diagnosticLabel === "contradicted"),
    label_misleading: Number(decision.diagnosticLabel === "misleading"),
    cited_assessments_log1p: Math.log1p(cited.length),
    independent_origin_groups: groups("independent"),
    unknown_dependence_groups: groups("unknown"),
    primary_directness_share:
      cited.filter(({ directness }) => directness === "primary").length / cited.length,
    scope_checks_all_pass: Number(
      cited.every(({ checks }) => checks.every(({ result }) => result !== "fail")),
    ),
    opposing_applicable_assessments: opposing.length,
    challenge_agreed: Number(decision.challenge.agreed === true),
    targeted_rounds_used: decision.challenge.targetedRoundsUsed,
    raw_confidence_present: Number(decision.rawModelConfidence !== null),
    raw_confidence: decision.rawModelConfidence ?? 0,
  };
}

export function featureVector(features: CalibrationFeatures) {
  return CALIBRATION_FEATURE_NAMES.map((name) => features[name]);
}
