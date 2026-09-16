import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ADJUDICATION_SCENARIOS,
  runAdjudicationScenario,
  type AdjudicationScenario,
} from "./support/adjudication-scenarios.js";

const arguments_ = new Map(
  process.argv
    .slice(2)
    .flatMap((value, index, values) =>
      value.startsWith("--") ? [[value.slice(2), values[index + 1] ?? ""]] : [],
    ),
);
const mode = arguments_.get("mode") ?? "fixture";
const split = arguments_.get("split") ?? "all";
const seed = Number(arguments_.get("seed") ?? 20260910);
if (mode !== "fixture")
  throw new Error(
    "Core adjudication evaluation supports fixture mode only; no production generation connector or adjudicated calibration data exists.",
  );
if (split !== "all") throw new Error("The adjudication invariant fixture has only the all split.");
if (seed !== 20260910)
  throw new Error("The adjudication invariant fixture requires seed 20260910.");

const fixtureBytes = await readFile(
  fileURLToPath(
    new URL("../src/core/adjudication/fixtures/adjudication-invariants.json", import.meta.url),
  ),
);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  cases: string[];
  humanGoldClaims: number;
};
const outcomes: Array<{ id: string; passed: boolean; error: string | null }> = [];
for (const id of fixture.cases) {
  try {
    if (!(ADJUDICATION_SCENARIOS as readonly string[]).includes(id))
      throw new Error(`Unknown adjudication case: ${id}`);
    await runAdjudicationScenario(id as AdjudicationScenario);
    outcomes.push({ id, passed: true, error: null });
  } catch (error) {
    outcomes.push({
      id,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const passed = outcomes.filter((outcome) => outcome.passed).length;
const notEvaluated = (target: string) => ({
  numerator: null,
  denominator: fixture.humanGoldClaims,
  target,
  status: "not_evaluated",
});
console.log(
  JSON.stringify(
    {
      mode,
      split,
      seed,
      datasetHash: `sha256:${createHash("sha256").update(fixtureBytes).digest("hex")}`,
      cases: outcomes,
      counts: { passed, failed: outcomes.length - passed, skipped: 0 },
      decisiveVerdicts: {
        supportedPrecision: notEvaluated("one-sided 95% Wilson lower bound >= 0.95"),
        contradictedPrecision: notEvaluated("one-sided 95% Wilson lower bound >= 0.95"),
      },
      coverage: notEvaluated(">= 0.70"),
      macroF1: notEvaluated(">= 0.85"),
      calibration: { ece: notEvaluated("<= 0.05"), brier: notEvaluated("report only") },
      calibrator: {
        status: "not_fitted",
        reason:
          "No independently adjudicated calibration partition exists; the fixture calibrator is synthetic.",
      },
      empiricalGateStatus: "not_evaluated",
      releaseApproved: false,
    },
    null,
    2,
  ),
);
if (passed !== outcomes.length) process.exitCode = 1;
