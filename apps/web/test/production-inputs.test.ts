import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";
import { expect, test } from "vite-plus/test";
import { validateProductionInputs } from "../scripts/production-inputs";

const read = (name: string) =>
  structuredClone(
    experimental_readRawConfig({ config: fileURLToPath(new URL(`../${name}`, import.meta.url)) })
      .rawConfig,
  ) as Record<string, any>;
const config = read("wrangler.production.json");
const stagingConfig = read("wrangler.jsonc");
const secrets = {
  BETTER_AUTH_SECRET: "synthetic-production-secret-with-at-least-32-chars",
  GITHUB_CLIENT_ID: "synthetic-github-client",
  GITHUB_CLIENT_SECRET: "synthetic-github-secret",
  AI_PROVIDER: "gemini",
  AI_MODEL: "synthetic-generation-model",
  AI_API_KEY: "synthetic-provider-key",
  AI_EMBEDDING_MODEL: "synthetic-embedding-model",
};
const built = { ...config, main: "index.js", vars: { ...config.vars } };
const valid = { config, stagingConfig, secrets, built };

test("the committed production config passes with complete synthetic secrets", () => {
  expect(() => validateProductionInputs(valid)).not.toThrow();
});

test("Google stays optional while both credentials are absent", () => {
  expect(() =>
    validateProductionInputs({
      ...valid,
      secrets: { ...secrets, GOOGLE_CLIENT_ID: "google-id", GOOGLE_CLIENT_SECRET: "google-secret" },
    }),
  ).not.toThrow();
  expect(() =>
    validateProductionInputs({ ...valid, secrets: { ...secrets, GOOGLE_CLIENT_ID: "google-id" } }),
  ).toThrow("both Google OAuth credentials");
});

test.each([
  [
    "staging resources",
    { config: { ...config, d1_databases: stagingConfig.d1_databases } },
    "differ from staging",
  ],
  ["workers.dev", { config: { ...config, workers_dev: true } }, "isolated production Worker"],
  [
    "a second origin",
    { config: { ...config, routes: [{ pattern: "staging.example", custom_domain: true }] } },
    "one HTTPS origin",
  ],
  [
    "missing GitHub in secrets.required",
    { config: { ...config, secrets: { required: ["BETTER_AUTH_SECRET"] } } },
    "require the GITHUB_CLIENT_ID",
  ],
  ["a staging build", { built: { ...stagingConfig, vars: config.vars } }, "build:production"],
])("rejects %s", (_name, override, message) => {
  expect(() => validateProductionInputs({ ...valid, ...override })).toThrow(message);
});

test.each([
  [{ MODE: "dev" }, "MODE=production"],
  [{ ANALYSIS_MODE: "fixture" }, "ANALYSIS_MODE=live"],
  [{ DEV_AUTH_BYPASS: "false" }, "Remove DEV_AUTH_BYPASS"],
  [{ GITHUB_CLIENT_SECRET: "replace-with-production-oauth-client-secret" }, "placeholder"],
  [{ GITHUB_CLIENT_ID: "" }, "Configure GITHUB_CLIENT_ID"],
  [{ BETTER_AUTH_SECRET: "too-short" }, "BETTER_AUTH_SECRET"],
  [{ BETTER_AUTH_SECRET: "tracera-local-development-secret-only" }, "BETTER_AUTH_SECRET"],
  [{ AI_PROVIDER: "" }, "AI provider configuration is incomplete"],
  [{ AI_PROVIDER: "anthropic" }, "AI provider configuration is incomplete"],
])("rejects secrets %o", (override, message) => {
  expect(() =>
    validateProductionInputs({ ...valid, secrets: { ...secrets, ...override } }),
  ).toThrow(message);
});

test("production secrets must differ from staging", () => {
  expect(() =>
    validateProductionInputs({
      ...valid,
      stagingSecrets: { BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET },
    }),
  ).toThrow("BETTER_AUTH_SECRET must be separate from staging");
});

test("errors never echo secret values", () => {
  const secret = "replace-me-but-never-print-this";
  let message = "";
  try {
    validateProductionInputs({ ...valid, secrets: { ...secrets, AI_API_KEY: secret } });
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("AI_API_KEY");
  expect(message).not.toContain(secret);
});
