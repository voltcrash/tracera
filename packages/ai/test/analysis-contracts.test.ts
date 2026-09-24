import assert from "node:assert/strict";
import {
  analysisExamples,
  focusedPublicationDecisionSchema,
  focusedPublicationPolicySchema,
  focusedSelectionSchema,
  runReportSchema,
  type RunReport,
} from "@repo/contracts/analysis";
import { test } from "vite-plus/test";

function mutate(change: (report: RunReport) => void) {
  const report = structuredClone(analysisExamples.complete);
  change(report);
  return runReportSchema.safeParse(report);
}

test("every saved report example is valid", () => {
  for (const [name, example] of Object.entries(analysisExamples)) {
    const result = runReportSchema.safeParse(example);
    assert.equal(result.success, true, `${name}: ${JSON.stringify(result.error?.issues)}`);
  }
});

test("analysis rejects dangling and invalid citations", () => {
  const dangling = mutate((report) => {
    report.decisions[0]!.supportingAssessmentIds = ["assess_missing"];
  });
  assert.equal(dangling.success, false);

  const invalidOffsets = mutate((report) => {
    report.assessments[0]!.excerpt.span = { start: 0, end: 4 };
  });
  assert.equal(invalidOffsets.success, false);

  const unvalidated = mutate((report) => {
    report.assessments[0]!.validationStatus = "needs_human_review";
  });
  assert.equal(unvalidated.success, false);
});

test("analysis rejects inconsistent and ungated score states", () => {
  const wrongScore = mutate((report) => {
    report.scorecard!.factualScore = 80;
  });
  assert.equal(wrongScore.success, false);

  const missingNullReason = mutate((report) => {
    report.scorecard!.inputStatus = "partial";
    report.scorecard!.factualScore = null;
  });
  assert.equal(missingNullReason.success, false);

  const scoredWhileGated = mutate((report) => {
    report.scorecard!.nullReasons = ["partial_input"];
  });
  assert.equal(scoredWhileGated.success, false);

  const scoredWhileCanceled = runReportSchema.safeParse({
    ...structuredClone(analysisExamples.canceled),
    scorecard: structuredClone(analysisExamples.complete).scorecard,
  });
  assert.equal(scoredWhileCanceled.success, false);
});

test("saved reports gate decisive labels behind calibration and challenge", () => {
  const uncalibrated = mutate((report) => {
    report.decisions[0]!.calibration = {
      applicability: "unavailable",
      calibratedCorrectness: null,
      calibratorVersion: null,
      reason: "No calibration artifact is frozen yet.",
    };
  });
  assert.equal(uncalibrated.success, false);

  const unresolvedChallenge = mutate((report) => {
    report.decisions[0]!.challenge.status = "unresolved";
  });
  assert.equal(unresolvedChallenge.success, false);
});

test("saved selection and publication identifiers remain readable", () => {
  assert.equal(
    focusedSelectionSchema.shape.policyVersion.parse("core-v2-focused-1.0.0"),
    "core-v2-focused-1.0.0",
  );
  assert.equal(
    focusedSelectionSchema.shape.selectionVersion.parse("core-v2-focused-selection-1.0.0"),
    "core-v2-focused-selection-1.0.0",
  );
  const calibration = {
    status: "not_used",
    probability: null,
    reason: "Focused policy is evidence-gated and does not use statistical calibration.",
  };
  const policy = focusedPublicationPolicySchema.parse({
    policyVersion: "core-v2-focused-publication-1.0.0",
    decisionVersion: "core-v2-focused-decision-1.0.0",
    mode: "evidence_gated",
    scoreFormulaVersion: "focused-supported-share-1.0.0",
    calibration,
  });
  assert.equal(policy.policyVersion, "core-v2-focused-publication-1.0.0");
  assert.equal(
    focusedPublicationPolicySchema.safeParse({
      ...policy,
      policyVersion: "tracera-publication-1.0.0",
    }).success,
    false,
  );
  const decision = focusedPublicationDecisionSchema.parse({
    policyVersion: policy.policyVersion,
    decisionVersion: policy.decisionVersion,
    status: "published",
    gate: "passed",
    calibration,
  });
  assert.equal(decision.decisionVersion, "core-v2-focused-decision-1.0.0");
});
