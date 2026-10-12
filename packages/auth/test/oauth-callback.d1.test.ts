import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { createD1Database } from "@repo/db";
import { createTestRuntime } from "@repo/db/test-runtime";
import { createAuth } from "@repo/auth";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeEach(async () => {
  runtime = await createTestRuntime();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await runtime?.dispose();
});
const origin = "https://tracera-staging.voltcrash.workers.dev";
const cookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

test.each(["google", "github"])(
  "stubbed %s authorization and callback persist a D1 session without tokens",
  async (provider) => {
    const auth = createAuth({
      db: createD1Database(runtime.db),
      origin,
      env: {
        MODE: "production",
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_SECRET: "synthetic-auth-secret-at-least-32-characters",
        GITHUB_CLIENT_ID: "stub-github-id",
        GITHUB_CLIENT_SECRET: "stub-github-secret",
        ...(provider === "google"
          ? { GOOGLE_CLIENT_ID: "stub-google-id", GOOGLE_CLIENT_SECRET: "stub-google-secret" }
          : {}),
      },
    });
    const calls: string[] = [];
    const email = `${provider}@tracera.test`;
    const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const idToken = `${jwtPart({ alg: "RS256" })}.${jwtPart({ sub: "google-account", name: "Stub Google", email, email_verified: true, picture: "https://provider.test/photo.png" })}.stub-signature`;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(url.origin + url.pathname);
      if (
        url.href === "https://oauth2.googleapis.com/token" ||
        url.href === "https://github.com/login/oauth/access_token"
      )
        return Response.json({
          access_token: "sentinel-access-token",
          refresh_token: "sentinel-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          ...(provider === "google" ? { id_token: idToken } : {}),
        });
      if (url.href === "https://api.github.com/user")
        return Response.json({
          id: 1234,
          login: "stub-github",
          name: "Stub GitHub",
          email,
          avatar_url: "https://provider.test/photo.png",
        });
      if (url.href === "https://api.github.com/user/emails")
        return Response.json([{ email, primary: true, verified: true }]);
      throw new Error("Unexpected OAuth stub request.");
    });
    const signIn = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ provider, callbackURL: `${origin}/home` }),
      }),
    );
    expect(signIn.status).toBe(200);
    const authorization = new URL(((await signIn.json()) as { url: string }).url);
    expect(authorization.hostname).toBe(
      provider === "google" ? "accounts.google.com" : "github.com",
    );
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/callback/${provider}`,
    );
    expect(authorization.searchParams.get("state")).toBeTruthy();
    const callback = new URL(`${origin}/api/auth/callback/${provider}`);
    callback.searchParams.set("code", "stub-code");
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    const response = await auth.handler(
      new Request(callback, { headers: { cookie: cookieHeader(signIn) } }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${origin}/home`);
    expect(response.headers.get("set-cookie")).toContain("Secure");
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader(response) }),
    });
    expect(session?.user.email).toBe(email);
    expect(session?.user.image).toMatch(/^trace:\d+$/);
    expect(
      await runtime.db
        .prepare(
          "SELECT access_token,refresh_token,id_token,access_token_expires_at,refresh_token_expires_at FROM accounts WHERE provider_id=?",
        )
        .bind(provider)
        .first(),
    ).toEqual({
      access_token: null,
      refresh_token: null,
      id_token: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
    });
    expect(calls).toEqual(
      provider === "google"
        ? ["https://oauth2.googleapis.com/token"]
        : [
            "https://github.com/login/oauth/access_token",
            "https://api.github.com/user",
            "https://api.github.com/user/emails",
          ],
    );
  },
);
