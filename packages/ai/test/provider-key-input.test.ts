import { expect, test } from "vite-plus/test";
import { personalProviderConfig, providerKeyInputSchema } from "../src/provider-key-input";

const valid = {
  provider: "openai",
  apiKey: "personal-secret",
  model: "chosen-model",
  embeddingModel: "chosen-embedding",
};
test("personal provider input trims keys and requires explicit model preferences", () => {
  expect(providerKeyInputSchema.parse({ ...valid, apiKey: " personal-secret " }).apiKey).toBe(
    valid.apiKey,
  );
  for (const changed of [
    { model: "" },
    { embeddingModel: "" },
    { apiKey: "short" },
    { apiKey: "key with spaces" },
    { provider: "fixture" },
    { unexpected: "secret" },
  ])
    expect(providerKeyInputSchema.safeParse({ ...valid, ...changed }).success).toBe(false);
});
test("Anthropic and separate embeddings require complete personal credentials", () => {
  expect(providerKeyInputSchema.safeParse({ ...valid, provider: "anthropic" }).success).toBe(false);
  const parsed = providerKeyInputSchema.parse({
    ...valid,
    provider: "anthropic",
    embeddingProvider: "gemini",
    embeddingApiKey: "embedding-secret",
  });
  expect(personalProviderConfig(parsed, parsed).embedding).toMatchObject({
    provider: "gemini",
    apiKey: "embedding-secret",
    dimensions: 1024,
  });
  expect(personalProviderConfig(parsed)).not.toHaveProperty("apiKey");
  expect(personalProviderConfig(parsed).embedding).not.toHaveProperty("apiKey");
  for (const changed of [{ embeddingApiKey: undefined }, { embeddingProvider: "anthropic" }])
    expect(providerKeyInputSchema.safeParse({ ...parsed, ...changed }).success).toBe(false);
});
test("custom URLs must be explicit HTTPS endpoints without credentials or URL decorations", () => {
  const compatible = { ...valid, provider: "openai-compatible" };
  expect(providerKeyInputSchema.safeParse(compatible).success).toBe(false);
  expect(
    providerKeyInputSchema.safeParse({ ...compatible, baseUrl: "https://provider.example/v1" })
      .success,
  ).toBe(true);
  for (const baseUrl of [
    "http://provider.example/v1",
    "https://secret@provider.example/v1",
    "https://provider.example:8443/v1",
    "https://provider.example/v1?key=secret",
    "https://provider.example/v1#fragment",
  ])
    expect(providerKeyInputSchema.safeParse({ ...compatible, baseUrl }).success).toBe(false);
  expect(
    providerKeyInputSchema.safeParse({ ...valid, baseUrl: "https://provider.example/v1" }).success,
  ).toBe(false);
});
