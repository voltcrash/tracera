import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createD1Database } from "@repo/db/d1";
import { createTestRuntime } from "@repo/db/test-runtime";
import { createAuth, type WorkerAuthEnv } from "@repo/auth/d1";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  runtime = await createTestRuntime();
});
afterAll(async () => {
  await runtime?.dispose();
});
const env: WorkerAuthEnv = {
  MODE: "dev",
  DEV_AUTH_BYPASS: "true",
  BETTER_AUTH_SECRET: "synthetic-auth-secret-at-least-32-characters",
};
const makeAuth = (origin: string, overrides: Partial<WorkerAuthEnv> = {}) =>
  createAuth({ db: createD1Database(runtime.db), env: { ...env, ...overrides }, origin });
const cookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

test.each(["http://localhost:3000", "http://127.0.0.1:4173", "http://[::1]:4197"])(
  "dev login persists a real D1 session at %s",
  async (origin) => {
    const response = await makeAuth(origin).handler(
      new Request(`${origin}/api/auth/dev-login?identity=ada`),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${origin}/home`);
    expect(response.headers.get("set-cookie")).toContain("tracera.session_token=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
    const session = await makeAuth(origin).api.getSession({
      headers: new Headers({ cookie: cookieHeader(response) }),
    });
    expect(session?.user.email).toBe("ada@tracera.local");
    expect(session?.user.image).toMatch(/^trace:\d+$/);
    expect(
      await runtime.db
        .prepare("SELECT count(*) FROM users WHERE email='ada@tracera.local'")
        .first("count(*)"),
    ).toBe(1);
    expect(
      await runtime.db
        .prepare("SELECT user_id FROM sessions WHERE id=?")
        .bind(session!.session.id)
        .first("user_id"),
    ).toBe(session!.user.id);
  },
);

test("logout removes its D1 session and invalidates the cookie on a fresh auth instance", async () => {
  const origin = "http://127.0.0.1:4173";
  const login = await makeAuth(origin).handler(
    new Request(`${origin}/api/auth/dev-login?identity=grace`),
  );
  const cookie = cookieHeader(login);
  const session = await makeAuth(origin).api.getSession({ headers: new Headers({ cookie }) });
  expect(session?.user.email).toBe("grace@tracera.local");
  const logout = await makeAuth(origin).handler(
    new Request(`${origin}/api/auth/sign-out`, { method: "POST", headers: { cookie, origin } }),
  );
  expect(logout.status).toBe(200);
  expect(await makeAuth(origin).api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
  expect(
    await runtime.db
      .prepare("SELECT id FROM sessions WHERE id=?")
      .bind(session!.session.id)
      .first(),
  ).toBeNull();
});

test("unknown identities and foreign request origins never receive a session", async () => {
  const auth = makeAuth("http://127.0.0.1:4173");
  for (const url of [
    "http://127.0.0.1:4173/api/auth/dev-login?identity=unknown",
    "http://localhost:4173/api/auth/dev-login?identity=ada",
    "https://dev.tracera.test/api/auth/dev-login?identity=ada",
  ]) {
    const response = await auth.handler(new Request(url));
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
});

test("production and disabled bypass configurations never register dev login", async () => {
  const origin = "https://tracera-staging.voltcrash.workers.dev";
  for (const overrides of [
    { DEV_AUTH_BYPASS: "false" },
    {
      MODE: "production" as const,
      BETTER_AUTH_URL: origin,
      GITHUB_CLIENT_ID: "stub-id",
      GITHUB_CLIENT_SECRET: "stub-secret",
    },
  ]) {
    const response = await makeAuth(origin, overrides).handler(
      new Request(`${origin}/api/auth/dev-login?identity=ada`),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
});

test("the dev identities endpoint lists names only on the configured loopback origin", async () => {
  const origin = "http://127.0.0.1:4173";
  const auth = makeAuth(origin);
  const response = await auth.handler(new Request(`${origin}/api/auth/dev-identities`));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    identities: [
      { id: "ada", name: "Ada Local" },
      { id: "grace", name: "Grace Local" },
    ],
  });
  for (const url of [
    "http://localhost:4173/api/auth/dev-identities",
    "https://dev.tracera.test/api/auth/dev-identities",
  ])
    expect((await auth.handler(new Request(url))).status).toBe(404);
});

test("production and disabled bypass configurations never list dev identities", async () => {
  const origin = "https://tracera-staging.voltcrash.workers.dev";
  for (const overrides of [
    { DEV_AUTH_BYPASS: "false" },
    {
      MODE: "production" as const,
      BETTER_AUTH_URL: origin,
      GITHUB_CLIENT_ID: "stub-id",
      GITHUB_CLIENT_SECRET: "stub-secret",
    },
  ]) {
    const response = await makeAuth(origin, overrides).handler(
      new Request(`${origin}/api/auth/dev-identities`),
    );
    expect(response.status).toBe(404);
  }
});
