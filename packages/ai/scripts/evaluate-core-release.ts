import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  RELEASE_FIXTURE_SCENARIOS,
  runReleaseFixtureScenario,
  type ReleaseFixtureScenario,
} from "./support/release-scenarios.js";

const arguments_ = process.argv.slice(2);
const mode = value("--mode") ?? "fixture";
const split = value("--split") ?? "all";
const seed = Number(value("--seed") ?? 20260910);

if (mode !== "fixture") {
  console.error(
    JSON.stringify({
      mode,
      status: "not_evaluated",
      reason:
        "Live and replayed release evaluation require the Task 12 human-gold, authorization, and provider prerequisites.",
    }),
  );
  process.exit(1);
}
if (split !== "all" || seed !== 20260910)
  throw new Error("The frozen release fixture requires split=all and seed=20260910.");

const fixturePath = fileURLToPath(new URL("../evaluation/release-fixtures.json", import.meta.url));
const fixtureBytes = await readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  version: string;
  seed: number;
  humanGoldClaims: number;
  cases: ReleaseFixtureScenario[];
};
if (fixture.seed !== seed || !sameCases(fixture.cases, RELEASE_FIXTURE_SCENARIOS))
  throw new Error("The release fixture manifest and implemented scenarios differ.");

const cases = [];
for (const id of fixture.cases) {
  try {
    const result = await runReleaseFixtureScenario(id);
    cases.push({ id, status: "passed", checks: result.checks });
  } catch (error) {
    cases.push({
      id,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const failed = cases.filter(({ status }) => status === "failed").length;
const report = {
  reportVersion: "1.0.0",
  evaluator: fixture.version,
  mode,
  split,
  seed,
  fixtureHash: `sha256:${createHash("sha256").update(fixtureBytes).digest("hex")}`,
  passed: cases.length - failed,
  failed,
  skipped: 0,
  checks: cases.reduce((sum, result) => sum + (result.checks?.length ?? 0), 0),
  cases,
  humanGoldClaims: fixture.humanGoldClaims,
  empiricalMetrics: {
    status: "not_evaluated",
    numerator: null,
    denominator: 0,
    confidenceInterval: null,
  },
  cost: { status: "not_evaluated", actualUsd: null },
  latency: { status: "not_evaluated", p50Ms: null, p95Ms: null },
  releaseGateStatus: "blocked",
  releaseApproved: false,
};
console.log(JSON.stringify(report, null, 2));
if (failed > 0 || cases.length === 0) process.exitCode = 1;

function value(flag: string) {
  const index = arguments_.indexOf(flag);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function sameCases(left: string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
