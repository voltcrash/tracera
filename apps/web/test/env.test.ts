import { afterEach, expect, test } from "vite-plus/test";
import { parseServerEnv, serverEnv, ServerEnvError } from "../src/server/env";
import { setTestEnv } from "./support/cloudflare-workers";

const bindings = {
  DB: { prepare() {} },
  BLOBS: { put() {} },
  ANALYSIS_WORKFLOW: { create() {} },
};
const local = {
  ...bindings,
  MODE: "dev",
  ANALYSIS_MODE: "fixture",
  DEV_AUTH_BYPASS: "true",
  BETTER_AUTH_SECRET: "tracera-local-development-secret-only",
  VERSION: "local",
};
const production = {
  ...bindings,
  MODE: "production",
  ANALYSIS_MODE: "live",
  BETTER_AUTH_URL: "https://tracera.voltcrash.com",
  BETTER_AUTH_SECRET: "synthetic-production-secret-with-enough-length",
  VERSION: "26.10.12",
};

afterEach(() => setTestEnv({}));

test("local development settings parse with fixture analysis and the dev bypass", () => {
  const env = parseServerEnv(local);
  expect(env).toMatchObject({ MODE: "dev", ANALYSIS_MODE: "fixture", DEV_AUTH_BYPASS: "true" });
  expect(env.DB).toBe(bindings.DB);
});

test("production settings parse with live analysis and one HTTPS origin", () => {
  expect(parseServerEnv(production)).toMatchObject({ MODE: "production", ANALYSIS_MODE: "live" });
});

test("blank optional settings read as absent", () => {
  const env = parseServerEnv({ ...local, AI_API_KEY: "  ", VERSION: "" });
  expect(env.AI_API_KEY).toBeUndefined();
  expect(env.VERSION).toBe("unknown");
});

test("analysis limits pass through as optional strings", () => {
  expect(parseServerEnv({ ...local, ANALYSIS_DAILY_QUOTA: "5" }).ANALYSIS_DAILY_QUOTA).toBe("5");
});

test.each([
  [{ ANALYSIS_MODE: "fixture" }, "ANALYSIS_MODE"],
  [{ DEV_AUTH_BYPASS: "true" }, "DEV_AUTH_BYPASS"],
  [{ BETTER_AUTH_URL: "http://tracera.voltcrash.com" }, "BETTER_AUTH_URL"],
  [{ BETTER_AUTH_URL: "https://tracera.voltcrash.com/api/auth" }, "BETTER_AUTH_URL"],
  [{ BETTER_AUTH_URL: undefined }, "BETTER_AUTH_URL"],
])("production rejects %o", (override, setting) => {
  expect(() => parseServerEnv({ ...production, ...override })).toThrow(new RegExp(`${setting}: `));
});

test.each(["DB", "BLOBS", "ANALYSIS_WORKFLOW"])("a missing %s binding is rejected", (name) => {
  expect(() => parseServerEnv({ ...local, [name]: undefined })).toThrow(`${name} binding`);
});

test.each([
  [{ MODE: "staging" }, "MODE"],
  [{ ANALYSIS_MODE: "replay" }, "ANALYSIS_MODE"],
  [{ DEV_AUTH_BYPASS: "yes" }, "DEV_AUTH_BYPASS"],
])("unknown switch values are rejected: %o", (override, setting) => {
  expect(() => parseServerEnv({ ...local, ...override })).toThrow(new RegExp(`${setting}: `));
});

test("errors never echo secret values", () => {
  const secret = "short-but-very-private";
  let error: unknown;
  try {
    parseServerEnv({ ...production, BETTER_AUTH_SECRET: secret, MODE: "invalid" });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ServerEnvError);
  expect(String(error)).toContain("BETTER_AUTH_SECRET");
  expect(String(error)).not.toContain(secret);
});

test("serverEnv reads the Worker's bindings", () => {
  setTestEnv(local);
  expect(serverEnv().MODE).toBe("dev");
  setTestEnv({});
  expect(() => serverEnv()).toThrow(ServerEnvError);
});
