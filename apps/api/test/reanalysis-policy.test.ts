import assert from "node:assert/strict";
import test from "node:test";
import { reanalysisPolicy } from "../src/reanalysis-policy.js";

const now = new Date("2026-08-09T12:00:00.000Z");

test("breaking stories use a short reuse and review window", () => {
  assert.deepEqual(
    reanalysisPolicy({
      inputType: "link",
      publishedAt: "2026-08-08T12:00:00.000Z",
      now,
    }),
    {
      band: "breaking",
      dedupHours: 2,
      nextReviewHours: 6,
      reason: "Breaking stories are reused briefly and checked again quickly.",
    },
  );
});

test("established stories back off to three days", () => {
  const policy = reanalysisPolicy({
    inputType: "link",
    publishedAt: "2026-01-01T00:00:00.000Z",
    now,
  });
  assert.equal(policy.band, "established");
  assert.equal(policy.dedupHours, 24);
  assert.equal(policy.nextReviewHours, 72);
});

test("thin evidence and an inconclusive score accelerate review", () => {
  const policy = reanalysisPolicy({
    inputType: "text",
    evidenceQuality: 0.3,
    overallScore: 50,
    now,
  });
  assert.equal(policy.band, "unknown");
  assert.equal(policy.dedupHours, 12);
  assert.equal(policy.nextReviewHours, 6);
  assert.match(policy.reason, /thin evidence and an inconclusive score/);
});

test("undated images use a shorter provenance window", () => {
  const policy = reanalysisPolicy({ inputType: "image", now });
  assert.equal(policy.dedupHours, 6);
  assert.equal(policy.nextReviewHours, 12);
});
