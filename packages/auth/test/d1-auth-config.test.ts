import { beforeAll, afterAll, expect, test } from "vite-plus/test";
import { createD1Database } from "@repo/db";
import { createTestRuntime } from "@repo/db/test-runtime";
import {
  createAuth,
  devAuthBypassEnabled,
  localAuthIdentities,
  type WorkerAuthEnv,
} from "@repo/auth";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  runtime = await createTestRuntime();
});
afterAll(async () => {
  await runtime?.dispose();
});
const dev: WorkerAuthEnv = {
  MODE: "dev",
  DEV_AUTH_BYPASS: "true",
  BETTER_AUTH_SECRET: "synthetic-auth-secret-at-least-32-characters",
};
const production: WorkerAuthEnv = {
  ...dev,
  MODE: "production",
  BETTER_AUTH_URL: "https://tracera-staging.voltcrash.workers.dev",
  GITHUB_CLIENT_ID: "synthetic-github-id",
  GITHUB_CLIENT_SECRET: "synthetic-github-secret",
};
const auth = (env: WorkerAuthEnv, origin = "http://127.0.0.1:4173") =>
  createAuth({ db: createD1Database(runtime.db), env, origin });

test.each(["http://localhost:3000", "http://127.0.0.1:4173", "http://[::1]:4197"])(
  "dev auth follows loopback origin %s without a fixed port",
  (origin) => {
    const instance = auth(dev, origin);
    expect(instance.options.baseURL).toBe(origin);
    expect(instance.options.trustedOrigins).toEqual([origin]);
    expect(instance.options.advanced?.useSecureCookies).toBe(false);
    expect(instance.options.advanced?.cookiePrefix).toBe("tracera");
    expect(instance.options.socialProviders).toEqual({});
    expect(localAuthIdentities(dev, origin)).toHaveLength(2);
    expect(instance.options.plugins?.map((plugin) => plugin.id)).toEqual([
      "tracera-dev-auth-bypass",
      "tanstack-start-cookies",
    ]);
  },
);

test.each([
  [{ ...dev, MODE: "production" as const }, "http://localhost:3000"],
  [{ ...dev, DEV_AUTH_BYPASS: "TRUE" }, "http://localhost:3000"],
  [dev, "https://dev.tracera.test"],
  [dev, "http://localhost.evil.test:3000"],
  [dev, "file://localhost/private"],
] as const)("dev bypass requires all mode, flag and loopback gates", (env, origin) => {
  expect(devAuthBypassEnabled(env, origin)).toBe(false);
  expect(localAuthIdentities(env, origin)).toBeNull();
});

test("production fixes the hosted origin and keeps GitHub enabled without Google", () => {
  const instance = auth(production);
  expect(instance.options.baseURL).toBe(production.BETTER_AUTH_URL);
  expect(instance.options.trustedOrigins).toEqual([production.BETTER_AUTH_URL]);
  expect(instance.options.advanced?.useSecureCookies).toBe(true);
  expect(Object.keys(instance.options.socialProviders ?? {})).toEqual(["github"]);
  expect(instance.options.plugins?.map((plugin) => plugin.id)).toEqual(["tanstack-start-cookies"]);
});

test("complete Google and GitHub pairs configure both provider implementations", () => {
  const instance = auth({
    ...production,
    GOOGLE_CLIENT_ID: "synthetic-google-id",
    GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
  });
  expect(Object.keys(instance.options.socialProviders ?? {})).toEqual(["google", "github"]);
});

test.each([
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const)("partial %s credentials fail without leaking their values", (field) => {
  const env = field.startsWith("GOOGLE")
    ? { ...production, [field]: "sentinel-credential" }
    : { ...production, [field]: undefined };
  expect(() => auth(env)).toThrow(/configured together/);
  try {
    auth(env);
  } catch (error) {
    expect(String(error)).not.toContain("sentinel-credential");
  }
});

test("production rejects missing GitHub, invalid hosted origins and short secrets", () => {
  expect(() =>
    auth({ ...production, GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined }),
  ).toThrow(/GitHub/);
  for (const origin of [
    "http://localhost:3000",
    "https://host.test/path",
    "https://user:password@host.test",
  ])
    expect(() => auth({ ...production, BETTER_AUTH_URL: origin })).toThrow(/HTTPS origin/);
  expect(() => auth({ ...dev, BETTER_AUTH_SECRET: "short" })).toThrow(/32 characters/);
});
