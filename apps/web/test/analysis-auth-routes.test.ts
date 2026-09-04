import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { app, type Bindings } from "../src/server/index";

const env = {
  DATABASE_URL: "postgresql://user:password@localhost/tracera",
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
} satisfies Bindings;

for (const path of ["/analyze", "/analyze/stream"]) {
  test(`${path} requires a signed-in user`, async () => {
    const response = await app.request(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "A claim to check." }),
      },
      env,
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "Sign in or create an account to start a fact-check.",
    });
  });

  test(`${path} rejects oversized bodies before parsing`, async () => {
    const response = await app.request(
      path,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "7100001",
        },
        body: JSON.stringify({ text: "A claim to check." }),
      },
      env,
    );

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "Request body is too large." });
  });
}

for (const path of ["/checks", "/checks/00000000-0000-4000-8000-000000000000"]) {
  test(`${path} requires a signed-in user`, async () => {
    const response = await app.request(path, {}, env);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "Sign in or create an account to open the News Hub.",
    });
  });
}
