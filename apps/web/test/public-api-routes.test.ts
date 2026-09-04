import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { app, type Bindings } from "../src/server/index";

const databaseEnv = {
  DATABASE_URL: "postgresql://user:password@localhost/tracera",
} satisfies Bindings;

test("OpenAPI discovery is public and does not require database setup", async () => {
  const response = await app.request("/v1/openapi.json");
  assert.equal(response.status, 200);
  const document = (await response.json()) as { openapi?: string };
  assert.equal(document.openapi, "3.1.0");
});

test("public data routes fail closed when API access is not configured", async () => {
  const response = await app.request("/v1/checks", {}, databaseEnv);
  assert.equal(response.status, 503);
  const payload = (await response.json()) as { error?: { code?: string } };
  assert.equal(payload.error?.code, "api_unavailable");
});

test("public data routes reject an invalid API key", async () => {
  const response = await app.request(
    "/v1/checks",
    { headers: { "x-api-key": "wrong" } },
    { ...databaseEnv, PUBLIC_API_KEYS: "correct" },
  );
  assert.equal(response.status, 401);
  const payload = (await response.json()) as { error?: { code?: string } };
  assert.equal(payload.error?.code, "unauthorized");
});
