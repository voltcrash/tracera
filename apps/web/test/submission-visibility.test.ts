import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { parseFirstPartyAnalysisInput } from "../src/server/analysis-input";
import { requestedVisibility } from "../src/server/submission-visibility";

test("new submissions default to private", () => {
  assert.equal(requestedVisibility({ text: "A claim to check." }, "user-id"), "private");
});

test("public submissions require explicit publication consent", () => {
  assert.throws(
    () => requestedVisibility({ text: "A claim to check.", visibility: "public" }, "user-id"),
    /submitted text, images, metadata, and analysis results public/,
  );
  assert.equal(
    requestedVisibility(
      { text: "A claim to check.", visibility: "public", publishConsent: true },
      "user-id",
    ),
    "public",
  );
});

test("publication consent must be a boolean", () => {
  const parsed = parseFirstPartyAnalysisInput({
    text: "A claim to check.",
    publishConsent: "yes",
  });

  assert.deepEqual(parsed, {
    success: false,
    error: "publishConsent must be a boolean.",
  });
});
