import { createTestRuntime } from "@repo/db/test-runtime";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { parseServerEnv, type ServerEnv } from "../src/server/env";
import { authFor, readSessionUser, signInOptions } from "../src/server/session";

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

test("an anonymous request has no session user", async () => {
  expect(await readSessionUser(env, new Request(`${origin}/home`))).toBeNull();
});

test("a dev sign-in yields the D1 session user", async () => {
  const login = await authFor(env, new Request(origin)).handler(
    new Request(`${origin}/api/auth/dev-login?identity=grace`),
  );
  const user = await readSessionUser(
    env,
    new Request(`${origin}/home`, { headers: { cookie: cookies(login) } }),
  );
  expect(user).toMatchObject({ email: "grace@tracera.local" });
  expect(user?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

const production = (secrets: Partial<ServerEnv>) =>
  ({ ...env, MODE: "production", DEV_AUTH_BYPASS: undefined, ...secrets }) as ServerEnv;

test("hosted sign-in offers GitHub alone while Google is unconfigured", () => {
  expect(
    signInOptions(
      production({ GITHUB_CLIENT_ID: "github-id", GITHUB_CLIENT_SECRET: "github-secret" }),
      "https://tracera.voltcrash.com",
    ),
  ).toEqual({ providers: ["github"], identities: null });
});

test("hosted sign-in offers both providers once both pairs are complete", () => {
  expect(
    signInOptions(
      production({
        GOOGLE_CLIENT_ID: "google-id",
        GOOGLE_CLIENT_SECRET: "google-secret",
        GITHUB_CLIENT_ID: "github-id",
        GITHUB_CLIENT_SECRET: "github-secret",
      }),
      "https://tracera.voltcrash.com",
    ).providers,
  ).toEqual(["google", "github"]);
});

test("a partial Google pair is never offered", () => {
  expect(
    signInOptions(
      production({
        GOOGLE_CLIENT_ID: "google-id",
        GITHUB_CLIENT_ID: "github-id",
        GITHUB_CLIENT_SECRET: "github-secret",
      }),
      "https://tracera.voltcrash.com",
    ).providers,
  ).toEqual(["github"]);
});

test("local development offers the dev identities on loopback origins only", () => {
  expect(signInOptions(env, origin).identities?.map(({ id }) => id)).toEqual(["ada", "grace"]);
  expect(signInOptions(env, "https://tracera.voltcrash.com").identities).toBeNull();
});
