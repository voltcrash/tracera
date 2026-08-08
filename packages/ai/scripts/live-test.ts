import {
  createAiProvider,
  type AiProviderConfig,
  type AiProviderName,
} from "../src/index.js";
import { z } from "zod";

const schema = z.object({
  greeting: z.literal("hello"),
  answer: z.literal(42),
});

const configuration = providerConfiguration();
const provider = createAiProvider(configuration);

const result = await provider.generate(
  'Return the exact JSON object {"greeting":"hello","answer":42}.',
  schema,
);

console.log(JSON.stringify({ provider: configuration.provider, result }, null, 2));

function providerConfiguration(): AiProviderConfig {
  const apiKey = requireEnvironment("AI_API_KEY");
  const embeddingProvider = process.env.AI_EMBEDDING_PROVIDER
    ? providerName(process.env.AI_EMBEDDING_PROVIDER)
    : undefined;
  const embeddingModel = process.env.AI_EMBEDDING_MODEL;
  return {
    provider: providerName(requireEnvironment("AI_PROVIDER")),
    apiKey,
    model: process.env.AI_MODEL,
    baseUrl: process.env.AI_BASE_URL,
    ...(embeddingProvider
      ? {
          embedding: {
            provider: embeddingProvider,
            apiKey: process.env.AI_EMBEDDING_API_KEY ?? apiKey,
            model: embeddingModel,
            baseUrl: process.env.AI_EMBEDDING_BASE_URL,
            dimensions: 1024,
          },
        }
      : { embeddingModel, embeddingDimensions: 1024 }),
  };
}

function providerName(value: string): AiProviderName {
  if (
    value === "anthropic" ||
    value === "gemini" ||
    value === "openai" ||
    value === "openrouter" ||
    value === "openai-compatible"
  ) {
    return value;
  }
  throw new Error(`Unsupported AI_PROVIDER: ${value}`);
}

function requireEnvironment(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}
