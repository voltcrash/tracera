import { AnthropicProvider } from "./providers/anthropic";
import { GeminiProvider } from "./providers/gemini";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible";
import { CompositeAiProvider } from "./composite-provider";
import type { AiProvider } from "./provider";
import { providerBaseUrl } from "./provider-endpoints";

export type AiProviderName = "anthropic" | "gemini" | "openai" | "openrouter" | "openai-compatible";

export interface ModelProviderConfig {
  provider: AiProviderName;
  apiKey?: string;
  model?: string;
  /** Required for openai-compatible; optional endpoint override except Gemini's fixed Google API. */
  baseUrl?: string;
}

export interface AiProviderConfig extends ModelProviderConfig {
  embeddingModel?: string;
  embeddingDimensions?: number;
  /** Use this when generation and embeddings come from different providers. */
  embedding?: ModelProviderConfig & { dimensions?: number };
}

export function createAiProvider(config: AiProviderConfig): AiProvider {
  const generation = createModelProvider(config, {
    embeddingModel: config.embeddingModel,
    embeddingDimensions: config.embeddingDimensions,
  });

  if (!config.embedding) return generation;

  const embedding = createModelProvider(config.embedding, {
    embeddingModel: config.embedding.model,
    embeddingDimensions: config.embedding.dimensions,
  });
  return new CompositeAiProvider(generation, embedding);
}

function createModelProvider(
  config: ModelProviderConfig,
  embedding: { embeddingModel?: string; embeddingDimensions?: number },
): AiProvider {
  const baseUrl = providerBaseUrl(config);
  switch (config.provider) {
    case "gemini":
      return new GeminiProvider({ ...config, ...embedding, apiKey: requireApiKey(config) });
    case "anthropic":
      return new AnthropicProvider({ ...config, baseUrl, apiKey: requireApiKey(config) });
    case "openai":
      return new OpenAiCompatibleProvider({
        ...config,
        apiKey: requireApiKey(config),
        ...embedding,
        baseUrl,
        providerName: "OpenAI",
      });
    case "openrouter":
      return new OpenAiCompatibleProvider({
        ...config,
        apiKey: requireApiKey(config),
        ...embedding,
        baseUrl,
        providerName: "OpenRouter",
      });
    case "openai-compatible":
      return new OpenAiCompatibleProvider({
        ...config,
        apiKey: requireApiKey(config),
        ...embedding,
        baseUrl,
      });
  }
}

function requireApiKey(config: ModelProviderConfig) {
  if (!config.apiKey) throw new Error(`${config.provider} requires an API key.`);
  return config.apiKey;
}
