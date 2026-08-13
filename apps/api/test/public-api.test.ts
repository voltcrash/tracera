import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  authenticatePublicApiKey,
  consumePublicApiQuota,
  parsePublicAnalysisInput,
  publicOpenApiDocument,
} from "../src/public-api.js";

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

test("public API keys support rotation without exposing the key identifier", async () => {
  const access = await authenticatePublicApiKey("new-secret", "old-secret,new-secret");
  assert.equal(access.authenticated, true);
  assert.equal(access.keyId?.length, 16);
  assert.equal(access.keyId?.includes("new-secret"), false);
  assert.deepEqual(await authenticatePublicApiKey("wrong", "old-secret,new-secret"), {
    authenticated: false,
  });
});

test("OpenAPI describes every public operation", () => {
  assert.ok(publicOpenApiDocument.paths["/v1/checks"].get);
  assert.ok(publicOpenApiDocument.paths["/v1/checks"].post);
  assert.ok(publicOpenApiDocument.paths["/v1/checks/{id}"].get);
});

test("shared quotas enforce minute and daily fixed windows", async () => {
  const counts = new Map<string, number>();
  const expirations: Array<[string, number]> = [];
  const store = {
    async incr(key: string) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count;
    },
    async expire(key: string, seconds: number) {
      expirations.push([key, seconds]);
    },
  };
  const options = { minuteLimit: 2, dailyLimit: 3, nowSeconds: 100_000 };
  assert.equal((await consumePublicApiQuota(store, "key", options)).allowed, true);
  const second = await consumePublicApiQuota(store, "key", options);
  assert.deepEqual(second, {
    allowed: true,
    limit: 2,
    remaining: 0,
    resetAt: 100_020,
  });
  const third = await consumePublicApiQuota(store, "key", options);
  assert.equal(third.allowed, false);
  assert.match(third.allowed ? "" : third.message, /per-minute/);
  const nextMinute = { ...options, nowSeconds: options.nowSeconds + 60 };
  assert.equal((await consumePublicApiQuota(store, "key", nextMinute)).allowed, true);
  const dailyExceeded = await consumePublicApiQuota(store, "key", nextMinute);
  assert.equal(dailyExceeded.allowed, false);
  assert.match(dailyExceeded.allowed ? "" : dailyExceeded.message, /daily/);
  assert.equal(expirations.length, 3);
});
