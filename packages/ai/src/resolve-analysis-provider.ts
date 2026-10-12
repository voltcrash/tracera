import type { AiProviderConfig, AiProviderName } from "./create-provider";

export type ProviderKeySource = "platform" | "user";
export interface AnalysisProviderEnvironment {
  AI_PROVIDER?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  AI_BASE_URL?: string;
  AI_EMBEDDING_PROVIDER?: string;
  AI_EMBEDDING_API_KEY?: string;
  AI_EMBEDDING_MODEL?: string;
  AI_EMBEDDING_BASE_URL?: string;
}
export interface ResolvedAnalysisProvider {
  source: "platform";
  config: AiProviderConfig & { model: string };
}

export class AnalysisProviderConfigurationError extends Error {}

const providers: readonly AiProviderName[] = [
  "anthropic",
  "gemini",
  "openai",
  "openrouter",
  "openai-compatible",
];
const setting = (value: string | undefined) => value?.trim() || undefined;
const reject = (message: string): never => {
  throw new AnalysisProviderConfigurationError(message);
};

function parseProvider(value: string | undefined): AiProviderName | undefined {
  const normalized = setting(value)?.toLowerCase();
  return normalized && providers.includes(normalized as AiProviderName)
    ? (normalized as AiProviderName)
    : undefined;
}

export function resolveAnalysisProvider({
  userId,
  env,
}: {
  userId: string;
  env: AnalysisProviderEnvironment;
}): ResolvedAnalysisProvider {
  if (!userId.trim()) reject("A user ID is required to resolve the analysis provider.");
  const provider = parseProvider(env.AI_PROVIDER);
  if (!provider) reject("A supported live AI_PROVIDER is required before analysis can start.");
  const apiKey = setting(env.AI_API_KEY);
  const model = setting(env.AI_MODEL);
  const embeddingModel = setting(env.AI_EMBEDDING_MODEL);
  if (!apiKey || !model || !embeddingModel)
    reject(
      "AI_API_KEY, AI_MODEL, and AI_EMBEDDING_MODEL must be configured before focused analysis can start.",
    );
  const baseUrl = setting(env.AI_BASE_URL);
  if (provider === "openai-compatible" && !baseUrl)
    reject("AI_BASE_URL is required for an openai-compatible live provider.");

  const embeddingProviderValue = setting(env.AI_EMBEDDING_PROVIDER);
  const embeddingProvider = parseProvider(embeddingProviderValue);
  const embeddingKey = setting(env.AI_EMBEDDING_API_KEY);
  const embeddingBaseUrl = setting(env.AI_EMBEDDING_BASE_URL);
  if (embeddingProviderValue && !embeddingProvider)
    reject("AI_EMBEDDING_PROVIDER is not a supported live provider.");
  if (!embeddingProvider && (embeddingKey || embeddingBaseUrl))
    reject("AI_EMBEDDING_PROVIDER must be configured with separate embedding credentials.");
  if (embeddingProvider === "anthropic")
    reject("Anthropic does not provide embeddings; choose a separate embedding provider.");
  if (embeddingProvider === "openai-compatible" && !embeddingBaseUrl)
    reject("AI_EMBEDDING_BASE_URL is required for an openai-compatible embedding provider.");
  if (embeddingProvider && !embeddingKey)
    reject("AI_EMBEDDING_API_KEY is required when a separate embedding provider is configured.");
  if (provider === "anthropic" && !embeddingProvider)
    reject("Anthropic needs an explicit AI_EMBEDDING_PROVIDER, key, and model for analysis.");

  return {
    source: "platform",
    config: {
      provider: provider!,
      apiKey: apiKey!,
      model: model!,
      baseUrl,
      ...(embeddingProvider
        ? {
            embedding: {
              provider: embeddingProvider,
              apiKey: embeddingKey!,
              model: embeddingModel!,
              baseUrl: embeddingBaseUrl,
              dimensions: 1024,
            },
          }
        : { embeddingModel: embeddingModel!, embeddingDimensions: 1024 }),
    },
  };
}
