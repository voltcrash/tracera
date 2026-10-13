import { z } from "zod";
import type { AiProviderConfig } from "./create-provider";
import type { ProviderKeyCredentials } from "./provider-key-crypto";

export const personalProviders = [
  "gemini",
  "openai",
  "anthropic",
  "openrouter",
  "openai-compatible",
] as const;
export const personalProviderSchema = z.enum(personalProviders);
const apiKey = z
  .string()
  .trim()
  .min(8)
  .max(4096)
  .regex(/^[!-~]+$/);
const model = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const baseUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash
    );
  }, "Use an HTTPS base URL without credentials, query parameters, or a port.");

export const providerKeyInputSchema = z
  .strictObject({
    provider: personalProviderSchema,
    apiKey,
    model,
    baseUrl: baseUrl.optional(),
    embeddingModel: model,
    embeddingProvider: z.enum(["gemini", "openai", "openrouter", "openai-compatible"]).optional(),
    embeddingApiKey: apiKey.optional(),
    embeddingBaseUrl: baseUrl.optional(),
  })
  .superRefine((value, context) => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if (value.provider === "openai-compatible" && !value.baseUrl)
      issue("baseUrl", "Provide the provider's HTTPS base URL.");
    if (value.provider !== "openai-compatible" && value.baseUrl)
      issue("baseUrl", "Custom base URLs require an OpenAI-compatible provider.");
    if (value.provider === "anthropic" && !value.embeddingProvider)
      issue("embeddingProvider", "Anthropic requires a separate embedding provider and key.");
    if (Boolean(value.embeddingProvider) !== Boolean(value.embeddingApiKey))
      issue("embeddingApiKey", "Provide both the embedding provider and its key.");
    if (value.embeddingProvider === "openai-compatible" && !value.embeddingBaseUrl)
      issue("embeddingBaseUrl", "Provide the embedding provider's HTTPS base URL.");
    if (value.embeddingProvider !== "openai-compatible" && value.embeddingBaseUrl)
      issue(
        "embeddingBaseUrl",
        "Custom embedding URLs require an OpenAI-compatible embedding provider.",
      );
  });

export type ProviderKeyInput = z.infer<typeof providerKeyInputSchema>;
export type ProviderKeyPreferences = Pick<
  ProviderKeyInput,
  "provider" | "model" | "embeddingModel"
> & {
  baseUrl?: string | null;
  embeddingProvider?: ProviderKeyInput["embeddingProvider"] | null;
  embeddingBaseUrl?: string | null;
};

export function personalProviderConfig(
  preferences: ProviderKeyPreferences,
  credentials?: ProviderKeyCredentials,
): AiProviderConfig & { model: string } {
  return {
    provider: preferences.provider,
    model: preferences.model,
    baseUrl: preferences.baseUrl ?? undefined,
    ...(credentials ? { apiKey: credentials.apiKey } : {}),
    ...(preferences.embeddingProvider
      ? {
          embedding: {
            provider: preferences.embeddingProvider,
            model: preferences.embeddingModel,
            baseUrl: preferences.embeddingBaseUrl ?? undefined,
            dimensions: 1024,
            ...(credentials ? { apiKey: credentials.embeddingApiKey } : {}),
          },
        }
      : { embeddingModel: preferences.embeddingModel, embeddingDimensions: 1024 }),
  };
}
