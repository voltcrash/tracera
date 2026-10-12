import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { createD1Database } from "@repo/db/d1";
import { createTestRuntime, seedUser } from "@repo/db/test-runtime";
import { createAuth } from "@repo/auth/d1";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeEach(async () => {
  runtime = await createTestRuntime();
  await seedUser(runtime.db);
});
afterEach(async () => {
  await runtime?.dispose();
});
const tokens = {
  accessToken: "sentinel-access-token",
  refreshToken: "sentinel-refresh-token",
  idToken: "sentinel-id-token",
  accessTokenExpiresAt: new Date("2030-01-01"),
  refreshTokenExpiresAt: new Date("2031-01-01"),
};

test.each(["google", "github"])(
  "%s account creation and updates discard OAuth material in D1",
  async (providerId) => {
    const auth = createAuth({
      db: createD1Database(runtime.db),
      origin: "https://tracera-staging.voltcrash.workers.dev",
      env: {
        MODE: "production",
        BETTER_AUTH_URL: "https://tracera-staging.voltcrash.workers.dev",
        BETTER_AUTH_SECRET: "synthetic-auth-secret-at-least-32-characters",
        GITHUB_CLIENT_ID: "stub-github-id",
        GITHUB_CLIENT_SECRET: "stub-github-secret",
        GOOGLE_CLIENT_ID: "stub-google-id",
        GOOGLE_CLIENT_SECRET: "stub-google-secret",
      },
    });
    expect(auth.options.session?.cookieCache?.enabled).toBe(false);
    expect(auth.options.account?.encryptOAuthTokens).toBe(true);
    expect(auth.options.account?.updateAccountOnSignIn).toBe(false);
    expect(auth.options.account?.storeAccountCookie).toBe(false);
    const adapter = (await auth.$context).internalAdapter;
    const account = await adapter.createAccount({
      accountId: "provider-account",
      providerId,
      userId: "user-1",
      ...tokens,
    });
    const readTokens = () =>
      runtime.db
        .prepare(
          "SELECT access_token,refresh_token,id_token,access_token_expires_at,refresh_token_expires_at FROM accounts WHERE id=?",
        )
        .bind(account.id)
        .first();
    const empty = {
      access_token: null,
      refresh_token: null,
      id_token: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
    };
    expect(await readTokens()).toEqual(empty);
    await adapter.updateAccount(account.id, { ...tokens, scope: "read:user" });
    expect(await readTokens()).toEqual(empty);
    expect(
      await runtime.db
        .prepare("SELECT provider_id,account_id,scope FROM accounts WHERE id=?")
        .bind(account.id)
        .first(),
    ).toEqual({ provider_id: providerId, account_id: "provider-account", scope: "read:user" });
  },
);
