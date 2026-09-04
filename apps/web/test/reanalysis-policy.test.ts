import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { reanalysisPolicy } from "../src/server/reanalysis-policy";

const now = new Date("2026-08-09T12:00:00.000Z");

test("breaking stories use a short reuse window", () => {
  assert.deepEqual(
    reanalysisPolicy({
      inputType: "link",
      publishedAt: "2026-08-08T12:00:00.000Z",
      now,
    }),
    {
      band: "breaking",
      dedupHours: 2,
      reason: "Breaking stories reuse identical results for only a short period.",
    },
  );
});

test("established stories use a one-day reuse window", () => {
  const policy = reanalysisPolicy({
    inputType: "link",
    publishedAt: "2026-01-01T00:00:00.000Z",
    now,
  });
  assert.equal(policy.band, "established");
  assert.equal(policy.dedupHours, 24);
});

test("undated text uses the standard reuse window", () => {
  const policy = reanalysisPolicy({ inputType: "text", now });
  assert.equal(policy.band, "unknown");
  assert.equal(policy.dedupHours, 12);
});

test("undated images use a shorter provenance window", () => {
  const policy = reanalysisPolicy({ inputType: "image", now });
  assert.equal(policy.dedupHours, 6);
});
