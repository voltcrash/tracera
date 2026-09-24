import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  FOCUSED_SCENARIOS,
  runFocusedScenario,
  type FocusedScenario,
} from "./support/focused-scenarios.js";

const arguments_ = new Map(
  process.argv
    .slice(2)
    .map((value, index, values) =>
      value.startsWith("--") ? [value.slice(2), values[index + 1] ?? "true"] : [value, "true"],
    ),
);
const mode = arguments_.get("mode") ?? "fixture";
const split = arguments_.get("split") ?? "all";
const seed = Number(arguments_.get("seed") ?? 20260910);
if (mode !== "fixture") throw new Error("Analysis evaluation supports fixture mode only.");
if (split !== "all") throw new Error("The focused invariant fixture has only the all split.");
if (seed !== 20260910) throw new Error("The focused invariant fixture requires seed 20260910.");

const fixtureBytes = await readFile(
  fileURLToPath(new URL("../src/analysis/fixtures/focused-invariants.json", import.meta.url)),
);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  version: string;
  humanGoldClaims: number;
  cases: FocusedScenario[];
};
const declared = new Set(fixture.cases);
if (
  declared.size !== FOCUSED_SCENARIOS.length ||
  FOCUSED_SCENARIOS.some((scenario) => !declared.has(scenario))
) {
  throw new Error("The focused invariant fixture and implemented scenarios differ.");
}

const cases = [];
for (const scenario of fixture.cases) {
  try {
    await runFocusedScenario(scenario);
    cases.push({ id: scenario, status: "passed" as const, error: null });
  } catch (error) {
    cases.push({
      id: scenario,
      status: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const failed = cases.filter(({ status }) => status === "failed").length;
console.log(
  JSON.stringify(
    {
      evaluator: fixture.version,
      mode,
      split,
      seed,
      datasetHash: `sha256:${createHash("sha256").update(fixtureBytes).digest("hex")}`,
      cases,
      counts: { passed: cases.length - failed, failed, skipped: 0 },
      humanGoldClaims: fixture.humanGoldClaims,
      empiricalFactualAccuracy: {
        numerator: null,
        denominator: fixture.humanGoldClaims,
        status: "not_evaluated",
      },
      empiricalGateStatus: "not_evaluated",
      releaseApproved: false,
    },
    null,
    2,
  ),
);
if (failed > 0 || cases.length === 0) process.exitCode = 1;
