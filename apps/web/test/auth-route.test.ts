import { createTestRuntime } from "@repo/db/test-runtime";
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { handleAuthRequest, publicAuthResponse } from "../src/server/auth-handler";
import { parseServerEnv, type ServerEnv } from "../src/server/env";
import { GENERIC_ERROR_MESSAGE } from "../src/server/error-handling";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let env: ServerEnv;
beforeAll(async () => {
  runtime = await createTestRuntime();
  env = parseServerEnv({
    DB: runtime.db,
    BLOBS: runtime.bucket,
    ANALYSIS_WORKFLOW: { create() {} },
    MODE: "dev",
    ANALYSIS_MODE: "fixture",
    DEV_AUTH_BYPASS: "true",
    BETTER_AUTH_SECRET: "synthetic-auth-secret-at-least-32-characters",
  });
});
afterAll(async () => {
  await runtime?.dispose();
});

const origin = "http://localhost:3000";
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
const session = (cookie: string) =>
  handleAuthRequest(env, new Request(`${origin}/api/auth/get-session`, { headers: { cookie } }));

test.each(["ada", "grace"])("dev sign-in as %s persists a session and signs out", async (id) => {
  const login = await handleAuthRequest(
    env,
    new Request(`${origin}/api/auth/dev-login?identity=${id}`),
  );
  expect(login.status).toBe(302);
  expect(login.headers.get("location")).toBe(`${origin}/home`);
  const cookie = cookies(login);
  expect(cookie).toMatch(/^tracera\.session_token=/);

  for (let reload = 0; reload < 2; reload += 1) {
    const current = await session(cookie);
    expect(((await current.json()) as { user: { email: string } }).user.email).toBe(
      `${id}@tracera.local`,
    );
  }

  const signOut = await handleAuthRequest(
    env,
    new Request(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(signOut.status).toBe(200);
  expect(signOut.headers.getSetCookie().join()).toMatch(/Max-Age=0/);
  expect(await (await session(cookie)).json()).toBeNull();
});

test("dev identities are served through the auth route", async () => {
  const response = await handleAuthRequest(env, new Request(`${origin}/api/auth/dev-identities`));
  expect(await response.json()).toMatchObject({ identities: [{ id: "ada" }, { id: "grace" }] });
});

test("Better Auth 5xx responses become the generic error body", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const response = publicAuthResponse(
    new Response("database exploded at host=secret", {
      status: 503,
      headers: { "content-encoding": "gzip", "set-cookie": "kept=1" },
    }),
    new Request(`${origin}/api/auth/get-session`, { headers: { "x-request-id": "req-1" } }),
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("content-encoding")).toBeNull();
  expect(response.headers.get("x-request-id")).toBe("req-1");
  expect(await response.json()).toEqual({
    error: GENERIC_ERROR_MESSAGE,
    message: GENERIC_ERROR_MESSAGE,
    code: "INTERNAL_SERVER_ERROR",
    requestId: "req-1",
  });
  expect(error).toHaveBeenCalledOnce();
  error.mockRestore();
});

test("responses below 500 pass through unchanged", () => {
  const original = new Response("nope", { status: 401 });
  expect(publicAuthResponse(original, new Request(origin))).toBe(original);
});

test("configuration failures answer with the generic error instead of throwing", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const response = await handleAuthRequest(
    { ...env, GOOGLE_CLIENT_ID: "only-half-a-pair" },
    new Request(`${origin}/api/auth/get-session`),
  );
  expect(response.status).toBe(500);
  expect(((await response.json()) as { error: string }).error).toBe(GENERIC_ERROR_MESSAGE);
  expect(JSON.stringify(error.mock.calls)).not.toContain("only-half-a-pair");
  error.mockRestore();
});
