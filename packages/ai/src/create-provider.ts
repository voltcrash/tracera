import { AnthropicProvider } from "./providers/anthropic.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.js";
import { CompositeAiProvider } from "./composite-provider.js";
import type { AiProvider } from "./provider.js";

export type AiProviderName = "anthropic" | "gemini" | "openai" | "openrouter" | "openai-compatible";

export interface ModelProviderConfig {
  provider: AiProviderName;
  apiKey: string;
  model?: string;
  /** Required only for `openai-compatible`; optional to override a built-in endpoint. */
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
  switch (config.provider) {
    case "gemini":
      return new GeminiProvider({ ...config, ...embedding });
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai":
      return new OpenAiCompatibleProvider({
        ...config,
        ...embedding,
        baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
        providerName: "OpenAI",
      });
    case "openrouter":
      return new OpenAiCompatibleProvider({
        ...config,
        ...embedding,
        baseUrl: config.baseUrl ?? "https://openrouter.ai/api/v1",
        providerName: "OpenRouter",
      });
    case "openai-compatible":
      if (!config.baseUrl) {
        throw new Error("AI_BASE_URL is required when AI_PROVIDER=openai-compatible.");
      }
      return new OpenAiCompatibleProvider({
        ...config,
        ...embedding,
        baseUrl: config.baseUrl,
      });
  }
}
