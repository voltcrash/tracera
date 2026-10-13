import { expect, test } from "vite-plus/test";
import {
  resolveAnalysisProvider,
  AnalysisProviderConfigurationError,
  type AnalysisProviderEnvironment,
} from "../src/resolve-analysis-provider";

const platform: AnalysisProviderEnvironment = {
  AI_PROVIDER: "gemini",
  AI_API_KEY: "platform-secret",
  AI_MODEL: "generation",
  AI_EMBEDDING_MODEL: "embedding",
};
const resolve = (env: AnalysisProviderEnvironment = platform) =>
  resolveAnalysisProvider({ userId: "user-1", env });

test("active personal configuration takes precedence and never borrows platform credentials", () => {
  const userConfig = {
    provider: "anthropic" as const,
    apiKey: "user-generation-key",
    model: "user-model",
    embedding: {
      provider: "openai" as const,
      apiKey: "user-embedding-key",
      model: "user-embedding-model",
    },
  };
  const resolved = resolveAnalysisProvider({ userId: "user-1", env: platform, userConfig });
  expect(resolved).toMatchObject({
    source: "user",
    config: {
      apiKey: "user-generation-key",
      model: "user-model",
      embedding: { apiKey: "user-embedding-key" },
    },
  });
  expect(JSON.stringify(resolved)).not.toContain("platform-secret");
  expect(resolveAnalysisProvider({ userId: "user-1", env: {}, userConfig }).source).toBe("user");
  expect(() =>
    resolveAnalysisProvider({
      userId: "user-1",
      env: platform,
      userConfig: { ...userConfig, apiKey: undefined },
    }),
  ).toThrow(AnalysisProviderConfigurationError);
});

test("the resolver returns platform configuration from explicit vars and secrets", () => {
  expect(resolve()).toEqual({
    source: "platform",
    config: {
      provider: "gemini",
      apiKey: "platform-secret",
      model: "generation",
      baseUrl: undefined,
      embeddingModel: "embedding",
      embeddingDimensions: 1024,
    },
  });
  expect(resolveAnalysisProvider({ userId: "user-2", env: platform })).toEqual(resolve());
  expect(
    resolve({ ...platform, AI_PROVIDER: " OpenAI ", AI_MODEL: " generation " }).config.provider,
  ).toBe("openai");
});

test("the resolver rejects missing generation settings and unsupported providers", () => {
  for (const name of ["AI_PROVIDER", "AI_API_KEY", "AI_MODEL", "AI_EMBEDDING_MODEL"] as const) {
    expect(() => resolve({ ...platform, [name]: " " })).toThrow(AnalysisProviderConfigurationError);
  }
  expect(() => resolve({ ...platform, AI_PROVIDER: "fixture" })).toThrow(
    AnalysisProviderConfigurationError,
  );
  expect(() => resolveAnalysisProvider({ userId: " ", env: platform })).toThrow(/user ID/);
});

test("OpenAI-compatible generation and embeddings require their own base URLs", () => {
  expect(() => resolve({ ...platform, AI_PROVIDER: "openai-compatible" })).toThrow(/AI_BASE_URL/);
  expect(
    resolve({
      ...platform,
      AI_PROVIDER: "openai-compatible",
      AI_BASE_URL: "https://compatible.example/v1",
    }).config.baseUrl,
  ).toBe("https://compatible.example/v1");
  expect(() =>
    resolve({
      ...platform,
      AI_EMBEDDING_PROVIDER: "openai-compatible",
      AI_EMBEDDING_API_KEY: "embedding-secret",
    }),
  ).toThrow(/AI_EMBEDDING_BASE_URL/);
});

test("Anthropic requires a complete separate provider for embeddings", () => {
  expect(() => resolve({ ...platform, AI_PROVIDER: "anthropic" })).toThrow(
    /explicit AI_EMBEDDING_PROVIDER/,
  );
  const resolved = resolve({
    ...platform,
    AI_PROVIDER: "anthropic",
    AI_EMBEDDING_PROVIDER: "openai",
    AI_EMBEDDING_API_KEY: "embedding-secret",
  });
  expect(resolved.config.embedding).toEqual({
    provider: "openai",
    apiKey: "embedding-secret",
    model: "embedding",
    baseUrl: undefined,
    dimensions: 1024,
  });
  expect(resolved.config.embeddingModel).toBeUndefined();
  expect(() =>
    resolve({
      ...platform,
      AI_EMBEDDING_PROVIDER: "anthropic",
      AI_EMBEDDING_API_KEY: "embedding-secret",
    }),
  ).toThrow(/does not provide embeddings/);
});

test("embedding credentials must be paired and configuration errors never echo secrets", () => {
  for (const extra of [
    { AI_EMBEDDING_API_KEY: "secret-sentinel" },
    { AI_EMBEDDING_BASE_URL: "https://secret-sentinel.example" },
    { AI_EMBEDDING_PROVIDER: "openai" },
    { AI_EMBEDDING_PROVIDER: "secret-sentinel" },
  ]) {
    try {
      resolve({ ...platform, ...extra });
      throw new Error("expected configuration rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisProviderConfigurationError);
      expect(String(error)).not.toContain("secret-sentinel");
    }
  }
});
