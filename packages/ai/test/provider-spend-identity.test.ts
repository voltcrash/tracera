import { expect, test } from "vite-plus/test";
import { providerSpendIdentity } from "../src/provider-spend-identity";
import type { AiProviderConfig } from "../src/create-provider";

const config: AiProviderConfig = {
  provider: "anthropic",
  model: "generation",
  apiKey: "generation-key",
  embedding: { provider: "openai", apiKey: "embedding-key", model: "embedding" },
};

test("spend identity separates provider and key source without retaining keys", () => {
  expect(providerSpendIdentity({ source: "platform", config }, "generate")).toEqual({
    providerKey: "anthropic",
    keySource: "platform",
  });
  expect(providerSpendIdentity({ source: "user", config }, "generate_image")).toEqual({
    providerKey: "anthropic",
    keySource: "user",
  });
  expect(
    JSON.stringify(providerSpendIdentity({ source: "platform", config }, "generate")),
  ).not.toContain("generation-key");
});

test("embedding spend is charged to its actual provider and retains the key source", () => {
  expect(providerSpendIdentity({ source: "platform", config }, "embed")).toEqual({
    providerKey: "openai",
    keySource: "platform",
  });
  expect(providerSpendIdentity({ source: "user", config }, "embed")).toEqual({
    providerKey: "openai",
    keySource: "user",
  });
  expect(
    providerSpendIdentity({ source: "platform", config: { provider: "gemini" } }, "embed"),
  ).toEqual({ providerKey: "gemini", keySource: "platform" });
});
