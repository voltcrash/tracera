import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { runInvariantFixture } from "../evaluation/harness.js";
import { clusteredBootstrap, wilsonLowerBound } from "../evaluation/metrics.js";
import { contentHash, evaluationDatasetSchema } from "../evaluation/schemas.js";

const dataset = evaluationDatasetSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../evaluation/fixtures/invariants.dataset.json", import.meta.url),
      "utf8",
    ),
  ),
);

test("core fixture detects required harness violations", () => {
  const result = runInvariantFixture(dataset, 20_260_910);
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.checks.map((check) => [check.id, check.detected]),
    [
      ["deliberately-wrong-verdict", true],
      ["invalid-citation", true],
      ["temporal-leakage", true],
      ["split-contamination", true],
    ],
  );
});

test("statistical helpers are deterministic and reject empty evidence", () => {
  assert.equal(
    contentHash("abc"),
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(wilsonLowerBound(0, 0), null);
  assert.ok((wilsonLowerBound(97, 100) ?? 0) < 0.95);
  const values = [
    { cluster: "story-a", delta: 1 },
    { cluster: "story-b", delta: 0 },
    { cluster: "story-c", delta: 1 },
  ];
  assert.deepEqual(clusteredBootstrap(values, 42, 10_000), clusteredBootstrap(values, 42, 10_000));
});
