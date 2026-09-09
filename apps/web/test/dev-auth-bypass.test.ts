import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createAuth, DEV_AUTH_BYPASS_PATH, devAuthBypassEnabled } from "@repo/auth";

const authEnv = {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
};

test("the development auth bypass requires both exact environment gates", () => {
  assert.equal(devAuthBypassEnabled({ NODE_ENV: "development", DEV_AUTH_BYPASS: "true" }), true);
  assert.equal(devAuthBypassEnabled({ NODE_ENV: "production", DEV_AUTH_BYPASS: "true" }), false);
  assert.equal(devAuthBypassEnabled({ NODE_ENV: "development", DEV_AUTH_BYPASS: "TRUE" }), false);
  assert.equal(devAuthBypassEnabled({ NODE_ENV: "development" }), false);
});

test("production auth uses the hosted origin behind an internal loopback URL", () => {
  const auth = createAuth(
    { ...authEnv, NODE_ENV: "production" },
    "http://localhost:3000/api/auth/sign-in/social",
  );

  assert.equal(auth.options.baseURL, "https://tracera.voltcrash.com");
});

test("the development login endpoint is not registered in production", async () => {
  const auth = createAuth(
    { ...authEnv, NODE_ENV: "production", DEV_AUTH_BYPASS: "true" },
    `https://tracera.voltcrash.com/api/auth${DEV_AUTH_BYPASS_PATH}`,
  );
  const response = await auth.handler(
    new Request(`https://tracera.voltcrash.com/api/auth${DEV_AUTH_BYPASS_PATH}`),
  );

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("the development login endpoint rejects non-loopback requests", async () => {
  const url = `https://dev.tracera.test/api/auth${DEV_AUTH_BYPASS_PATH}`;
  const auth = createAuth({ ...authEnv, NODE_ENV: "development", DEV_AUTH_BYPASS: "true" }, url);
  const response = await auth.handler(new Request(url));

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("set-cookie"), null);
});
