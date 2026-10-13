import { expect, test } from "vite-plus/test";
import { analysisPolicy, analysisRunContext } from "../src/server/analysis-policy";
import type { ServerEnv } from "../src/server/env";

const base = {
  MODE: "dev",
  ANALYSIS_MODE: "fixture",
  VERSION: "test",
  BETTER_AUTH_SECRET: "synthetic-auth-secret-at-least-32-characters",
} as ServerEnv;
const provider = {
  AI_PROVIDER: "openai",
  AI_API_KEY: "configured-provider-key",
  AI_MODEL: "configured-model",
  AI_EMBEDDING_MODEL: "configured-embedding-model",
};
const budget = {
  ANALYSIS_MAX_EXTERNAL_REQUESTS: "120",
  ANALYSIS_MAX_DISCOVERY_QUERIES_PER_CLAIM: "12",
  ANALYSIS_MAX_FETCHED_CANDIDATES_PER_CLAIM: "20",
  ANALYSIS_MAX_PROVENANCE_HOPS: "3",
  ANALYSIS_MAX_TARGETED_RETRIEVAL_ROUNDS: "2",
  ANALYSIS_MAX_ELAPSED_MS: "120000",
  ANALYSIS_MAX_CONCURRENT_EXTERNAL_CALLS: "3",
  ANALYSIS_MAX_COST_USD: "1.00",
};
const spend = {
  AI_DAILY_SPEND_LIMIT_USD: "25",
  AI_ESTIMATED_GENERATION_COST_USD: "0.01",
  AI_ESTIMATED_IMAGE_COST_USD: "0.02",
  AI_ESTIMATED_EMBEDDING_COST_USD: "0.0001",
};

test("local development runs deterministic fixture analysis without a provider", () => {
  const result = analysisPolicy(base, "ada");
  expect(result.enabled).toBe(true);
  if (result.enabled) {
    expect(result.policy.mode).toBe("fixture");
    expect(result.policy.providerConfig).toBeNull();
    expect(result.policy.versions.engine).toBe("tracera-analysis-1.0.0");
  }
});

test("fixture analysis is unavailable outside local development", () => {
  expect(analysisPolicy({ ...base, MODE: "production" }, "ada").enabled).toBe(false);
});

test("live analysis requires the provider, budget and spend settings", () => {
  const live = { ...base, ANALYSIS_MODE: "live" } as ServerEnv;
  expect(analysisPolicy(live, "ada").enabled).toBe(false);
  expect(analysisPolicy({ ...live, ...provider }, "ada").enabled).toBe(false);
  expect(analysisPolicy({ ...live, ...provider, ...budget }, "ada").enabled).toBe(false);
  const enabled = analysisPolicy({ ...live, ...provider, ...budget, ...spend }, "ada");
  expect(enabled.enabled).toBe(true);
  if (!enabled.enabled) return;
  expect(enabled.policy.mode).toBe("live");
  expect(enabled.policy.budget.maxCostUsd).toBe(1);
  const context = analysisRunContext("ada", { kind: "text", text: "A claim" }, enabled.policy);
  expect(context.provider).toEqual({ source: "platform", provider: "openai" });
  expect(context.versions.model).toBe("configured-model");
  expect(JSON.stringify(context)).not.toContain("configured-provider-key");
});

test("personal analysis needs run bounds and cost estimates but skips the platform daily spend bound", () => {
  const selection = {
    source: "user" as const,
    config: {
      provider: "openai" as const,
      model: "personal-model",
      embeddingModel: "personal-embedding",
    },
  };
  const env = {
    ...base,
    ANALYSIS_MODE: "live" as const,
    ...budget,
    ...spend,
    AI_DAILY_SPEND_LIMIT_USD: undefined,
  };
  expect(analysisPolicy(env, "ada", selection).enabled).toBe(true);
  expect(
    analysisPolicy({ ...env, ANALYSIS_MAX_COST_USD: undefined }, "ada", selection).enabled,
  ).toBe(false);
  expect(
    analysisPolicy({ ...env, AI_ESTIMATED_GENERATION_COST_USD: undefined }, "ada", selection)
      .enabled,
  ).toBe(false);
});
