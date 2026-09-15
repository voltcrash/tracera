import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ORCHESTRATION_SCENARIOS,
  runOrchestrationScenario,
  type OrchestrationScenario,
} from "./support/orchestration-scenarios.js";

const arguments_ = process.argv.slice(2);
const mode = value("--mode") ?? "fixture";
const split = value("--split") ?? "all";
const seed = Number(value("--seed") ?? 20260910);
if (mode !== "fixture") {
  console.error(
    JSON.stringify({
      mode,
      status: "not_evaluated",
      reason: "Live and replayed-retrieval orchestration evaluation require Task 12 authorization.",
    }),
  );
  process.exit(1);
}
if (split !== "all" || seed !== 20260910)
  throw new Error("The frozen orchestration fixture requires split=all and seed=20260910.");

const path = fileURLToPath(
  new URL("../src/core/fixtures/orchestration-invariants.json", import.meta.url),
);
const bytes = await readFile(path);
const fixture = JSON.parse(bytes.toString("utf8")) as {
  version: string;
  seed: number;
  humanGoldClaims: number;
  cases: OrchestrationScenario[];
};
const declared = new Set<string>(fixture.cases);
const implemented = new Set<string>(ORCHESTRATION_SCENARIOS);
if (
  declared.size !== implemented.size ||
  [...declared].some((scenario) => !implemented.has(scenario))
) {
  throw new Error("The fixture manifest and implemented orchestration scenarios differ.");
}

const results = [];
for (const scenario of fixture.cases) {
  try {
    const result = await runOrchestrationScenario(scenario);
    results.push({ id: scenario, status: "passed", checks: result.checks });
  } catch (error) {
    results.push({
      id: scenario,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
const failed = results.filter(({ status }) => status === "failed").length;
const report = {
  evaluator: fixture.version,
  mode,
  split,
  seed,
  datasetHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  passed: results.length - failed,
  failed,
  skipped: 0,
  checks: results.reduce((sum, result) => sum + (result.checks?.length ?? 0), 0),
  cases: results,
  humanGoldClaims: fixture.humanGoldClaims,
  empiricalMetrics: { status: "not_evaluated", numerator: null, denominator: 0 },
  releaseApproved: false,
};
console.log(JSON.stringify(report, null, 2));
if (failed > 0 || results.length === 0) process.exitCode = 1;

function value(flag: string) {
  const index = arguments_.indexOf(flag);
  return index >= 0 ? arguments_[index + 1] : undefined;
}
