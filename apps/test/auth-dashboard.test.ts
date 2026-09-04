import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createAuth } from "@repo/auth";

test("dashboard validation uses the hosted API when URL overrides are unset", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalWarn = console.warn;
  let requestedUrl: string | undefined;

  globalThis.fetch = async (input) => {
    requestedUrl = input instanceof Request ? input.url : new URL(input.toString()).href;
    return Response.json({ keys: [] });
  };
  console.error = () => undefined;
  console.warn = () => undefined;

  try {
    const auth = createAuth({
      BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
      BETTER_AUTH_API_KEY: "test-dashboard-key",
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
    });
    const response = await auth.handler(
      new Request("https://tracera.voltcrash.com/api/auth/dash/validate", {
        headers: { authorization: "Bearer invalid-dashboard-token" },
      }),
    );

    assert.equal(requestedUrl, "https://dash.better-auth.com/api/auth/jwks");
    assert.equal(response.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.warn = originalWarn;
  }
});
