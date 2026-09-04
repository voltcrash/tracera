import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  authenticatePublicApiKey,
  parseFirstPartyAnalysisInput,
  parsePublicAnalysisInput,
  publicOpenApiDocument,
} from "../src/server/public-api";

test("public input accepts exactly one supported input", () => {
  assert.deepEqual(parsePublicAnalysisInput({ text: "  A checkable claim.  " }), {
    success: true,
    data: { text: "A checkable claim." },
  });
  assert.equal(
    parsePublicAnalysisInput({ text: "claim", url: "https://example.com" }).success,
    false,
  );
  assert.equal(parsePublicAnalysisInput({}).success, false);
  assert.equal(parsePublicAnalysisInput({ text: "claim", forceReanalysis: true }).success, false);
});

test("public input rejects unsafe schemes and invalid image metadata", () => {
  assert.equal(parsePublicAnalysisInput({ url: "file:///etc/passwd" }).success, false);
  assert.equal(
    parsePublicAnalysisInput({
      image: "data:image/png;base64,AAAA",
      imageMimeType: "text/html",
    }).success,
    false,
  );
});

test("first-party input shares public size checks and permits supported metadata", () => {
  assert.deepEqual(
    parseFirstPartyAnalysisInput({
      text: "  A checkable claim.  ",
      sourceUrl: "https://example.com/story",
      forceReanalysis: true,
      visibility: "private",
    }),
    {
      success: true,
      data: {
        text: "A checkable claim.",
        sourceUrl: "https://example.com/story",
        forceReanalysis: true,
        visibility: "private",
      },
    },
  );
  assert.equal(parseFirstPartyAnalysisInput({ text: "x".repeat(50_001) }).success, false);
  assert.equal(
    parseFirstPartyAnalysisInput({ url: "https://example.com", extra: true }).success,
    false,
  );
});

test("public API keys support rotation", async () => {
  const access = await authenticatePublicApiKey("new-secret", "old-secret,new-secret");
  assert.deepEqual(access, { authenticated: true });
  assert.deepEqual(await authenticatePublicApiKey("wrong", "old-secret,new-secret"), {
    authenticated: false,
  });
});

test("OpenAPI describes every public operation", () => {
  assert.ok(publicOpenApiDocument.paths["/v1/checks"].get);
  assert.ok(publicOpenApiDocument.paths["/v1/checks"].post);
  assert.ok(publicOpenApiDocument.paths["/v1/checks/{id}"].get);
});
