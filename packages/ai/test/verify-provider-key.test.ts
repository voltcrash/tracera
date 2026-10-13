import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  verifyProviderKey,
  ProviderKeyRejectedError,
  ProviderKeyVerificationError,
} from "../src/verify-provider-key";
import { providerKeyInputSchema } from "../src/provider-key-input";

afterEach(() => vi.unstubAllGlobals());
const key = "personal-secret-canary";
const embeddingKey = "embedding-secret-canary";
const input = { apiKey: key, model: "chosen-model", embeddingModel: "chosen-embedding" };
const publicHost = { resolveHostAddresses: async () => ["8.8.8.8"] };

test.each(["gemini", "openai", "anthropic", "openrouter", "openai-compatible"] as const)(
  "%s verifies generation and 1024-dimensional embeddings with personal credentials",
  async (provider) => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        requests.push({
          url: String(url),
          headers: new Headers(init.headers),
          body: JSON.parse(String(init.body)),
        });
        if (String(url).includes("embed"))
          return Response.json(
            String(url).includes("googleapis")
              ? { embedding: { values: Array(1024).fill(0.1) } }
              : { data: [{ embedding: Array(1024).fill(0.1) }] },
          );
        return Response.json(
          provider === "gemini"
            ? { candidates: [] }
            : provider === "anthropic"
              ? { content: [] }
              : { choices: [] },
        );
      }),
    );
    const parsed = providerKeyInputSchema.parse({
      ...input,
      provider,
      ...(provider === "openai-compatible" ? { baseUrl: "https://compatible.example/v1" } : {}),
      ...(provider === "anthropic"
        ? { embeddingProvider: "openai", embeddingApiKey: embeddingKey }
        : {}),
    });
    await verifyProviderKey(parsed, publicHost);
    expect(requests).toHaveLength(2);
    expect([...requests[0]!.headers.values()].join()).toContain(key);
    expect(requests[0]!.body).toMatchObject(
      provider === "gemini"
        ? { generationConfig: { maxOutputTokens: 1 } }
        : provider === "openai"
          ? { max_completion_tokens: 1 }
          : { max_tokens: 1 },
    );
    expect([...requests[1]!.headers.values()].join()).toContain(
      provider === "anthropic" ? embeddingKey : key,
    );
    expect(JSON.stringify(requests[0]!.body)).not.toContain(key);
  },
);
test.each([401, 403, 429, 500])(
  "verification redacts HTTP %s and identifies rejected keys",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: key } }, { status })),
    );
    const error = await verifyProviderKey(
      providerKeyInputSchema.parse({ ...input, provider: "openai" }),
    ).catch((error) => error);
    expect(error).toBeInstanceOf(
      status === 401 || status === 403 ? ProviderKeyRejectedError : ProviderKeyVerificationError,
    );
    expect(String(error)).not.toContain(key);
  },
);
test("custom hosts are checked before credentials are sent, including private DNS answers", async () => {
  const transport = vi.fn(async () => Response.json({ choices: [] }));
  vi.stubGlobal("fetch", transport);
  for (const baseUrl of [
    "https://127.0.0.1/v1",
    "https://metadata.google.internal/v1",
    "https://private.example/v1",
  ])
    await expect(
      verifyProviderKey(
        providerKeyInputSchema.parse({ ...input, provider: "openai-compatible", baseUrl }),
        { resolveHostAddresses: async () => ["10.0.0.1"] },
      ),
    ).rejects.toBeInstanceOf(ProviderKeyVerificationError);
  expect(transport).not.toHaveBeenCalled();
});
test("verification rejects missing or incompatible embedding vectors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) =>
      Response.json(
        String(url).includes("embeddings") ? { data: [{ embedding: [1, 2, 3] }] } : { choices: [] },
      ),
    ),
  );
  await expect(
    verifyProviderKey(providerKeyInputSchema.parse({ ...input, provider: "openai" })),
  ).rejects.toBeInstanceOf(ProviderKeyVerificationError);
});
