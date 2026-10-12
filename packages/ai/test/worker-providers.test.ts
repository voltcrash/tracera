import { Response } from "miniflare";
import { expect, test } from "vite-plus/test";
import { createWorkerRuntime } from "./support/workerd-runtime";

for (const provider of ["gemini", "openai", "anthropic", "openrouter", "openai-compatible"]) {
  test(`workerd runs ${provider} structured generation, image generation and available embeddings through safeFetch`, async () => {
    let upstreamCalls = 0;
    const testRuntime = await createWorkerRuntime(async (request) => {
      upstreamCalls += 1;
      const url = new URL(request.url);
      expect(request.method).toBe("POST");
      expect(url.search).not.toContain("stub-provider-key");
      const body = await request.json();
      expect(JSON.stringify(body)).not.toContain("stub-provider-key");
      expect(request.headers.get("content-type")).toBe("application/json");
      const header =
        provider === "gemini"
          ? "x-goog-api-key"
          : provider === "anthropic"
            ? "x-api-key"
            : "authorization";
      expect(request.headers.get(header)).toBe(
        provider === "gemini" || provider === "anthropic"
          ? "stub-provider-key"
          : "Bearer stub-provider-key",
      );
      if (provider === "gemini") {
        expect(url.hostname).toBe("generativelanguage.googleapis.com");
        return Response.json(
          url.pathname.includes("embedContent")
            ? { embedding: { values: [0, 1, 2] } }
            : { candidates: [{ content: { parts: [{ text: '{"answer":"ok"}' }] } }] },
        );
      }
      if (provider === "anthropic") {
        expect(url.hostname).toBe("api.anthropic.com");
        return Response.json({ content: [{ type: "tool_use", input: { answer: "ok" } }] });
      }
      expect(url.hostname).toBe(
        provider === "openai"
          ? "api.openai.com"
          : provider === "openrouter"
            ? "openrouter.ai"
            : "compatible.example",
      );
      return Response.json(
        url.pathname.endsWith("/embeddings")
          ? { data: [{ embedding: [0, 1, 2] }] }
          : { choices: [{ message: { content: '{"answer":"ok"}' } }] },
      );
    });
    try {
      const response = await testRuntime.runtime.dispatchFetch(
        `http://worker/provider?provider=${provider}`,
      );
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result).toEqual({
        generated: { answer: "ok" },
        image: { answer: "ok" },
        embedding: provider === "anthropic" ? null : [0, 1, 2],
      });
      expect(upstreamCalls).toBe(provider === "anthropic" ? 2 : 3);
      expect(testRuntime.requests.filter((url) => url.includes("dns-query"))).toHaveLength(
        upstreamCalls * 2,
      );
    } finally {
      await testRuntime.dispose();
    }
  });
}
