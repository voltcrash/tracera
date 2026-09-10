import assert from "node:assert/strict";
import {
  coreV2Examples,
  runReportSchema,
  versionedRunReportSchema,
  type RunReport,
} from "@repo/contracts/core-v2";
import { test } from "vite-plus/test";

function mutate(change: (report: RunReport) => void) {
  const report = structuredClone(coreV2Examples.complete);
  change(report);
  return runReportSchema.safeParse(report);
}

test("every canonical core v2 example is valid", () => {
  for (const [name, example] of Object.entries(coreV2Examples)) {
    const result = versionedRunReportSchema.safeParse(example);
    assert.equal(result.success, true, `${name}: ${JSON.stringify(result.error?.issues)}`);
  }
});

test("core v2 rejects dangling and invalid citations", () => {
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

test("core v2 rejects inconsistent and ungated score states", () => {
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
    ...structuredClone(coreV2Examples.canceled),
    scorecard: structuredClone(coreV2Examples.complete).scorecard,
  });
  assert.equal(scoredWhileCanceled.success, false);
});

test("core v2 gates decisive labels behind calibration and challenge", () => {
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
