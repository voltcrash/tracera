import { GeminiProvider } from "./providers/gemini.js";
import type { AiProvider } from "./provider.js";

export type AiProviderConfig =
  | {
      provider: "gemini";
      apiKey: string;
      model?: string;
      embeddingModel?: string;
      embeddingDimensions?: number;
    };

export function createAiProvider(config: AiProviderConfig): AiProvider {
  return new GeminiProvider(config);
}
