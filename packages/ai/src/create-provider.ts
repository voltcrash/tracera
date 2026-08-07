import { GeminiProvider } from "./providers/gemini.js";
import { OllamaProvider } from "./providers/ollama.js";
import type { AiProvider } from "./provider.js";

export type AiProviderConfig =
  | { provider: "ollama"; baseUrl?: string; model?: string; embeddingModel?: string; signal?: AbortSignal }
  | {
      provider: "gemini";
      apiKey: string;
      model?: string;
      embeddingModel?: string;
      embeddingDimensions?: number;
    };

export function createAiProvider(config: AiProviderConfig): AiProvider {
  if (config.provider === "ollama") {
    return new OllamaProvider(config);
  }

  return new GeminiProvider(config);
}
