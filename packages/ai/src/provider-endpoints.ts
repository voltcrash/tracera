import type { ModelProviderConfig } from "./create-provider";

export const BUILTIN_PROVIDER_BASE_URLS = {
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
} as const;

export function providerBaseUrl(config: Pick<ModelProviderConfig, "provider" | "baseUrl">) {
  if (config.provider === "gemini") return BUILTIN_PROVIDER_BASE_URLS.gemini;
  const baseUrl =
    config.baseUrl ??
    (config.provider === "openai-compatible"
      ? undefined
      : BUILTIN_PROVIDER_BASE_URLS[config.provider]);
  if (!baseUrl) throw new Error("AI_BASE_URL is required when AI_PROVIDER=openai-compatible.");
  return baseUrl;
}
