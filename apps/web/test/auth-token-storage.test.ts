import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createAuth } from "@repo/auth";

const authEnv = {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
};

test("OAuth account storage encrypts and discards provider token material", async () => {
  const auth = createAuth(authEnv, "https://tracera.voltcrash.com/api/auth/callback/google");
  const before = auth.options.databaseHooks?.account?.create?.before;

  assert.equal(auth.options.account?.encryptOAuthTokens, true);
  assert.equal(auth.options.account?.updateAccountOnSignIn, false);
  assert.equal(auth.options.account?.storeAccountCookie, false);
  assert.ok(before);
  assert.deepEqual(await before(), {
    data: {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    },
  });
});
