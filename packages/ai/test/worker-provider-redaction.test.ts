import { Response } from "miniflare";
import { expect, test } from "vite-plus/test";
import { createWorkerRuntime } from "./support/workerd-runtime";

for (const provider of ["gemini", "openai", "anthropic", "openrouter", "openai-compatible"]) {
  test(`workerd redacts ${provider} errors that echo authorization headers`, async () => {
    const testRuntime = await createWorkerRuntime(async (request) => {
      expect(
        [
          request.headers.get("authorization"),
          request.headers.get("x-api-key"),
          request.headers.get("x-goog-api-key"),
        ].some((value) => value?.includes("stub-provider-key")),
      ).toBe(true);
      return Response.json(
        {
          error: {
            message: "Authorization: Bearer stub-provider-key; x-api-key: stub-provider-key",
          },
        },
        { status: 401 },
      );
    });
    try {
      const response = await testRuntime.runtime.dispatchFetch(
        `http://worker/provider?provider=${provider}`,
      );
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("HTTP 401");
      expect(body).not.toContain("stub-provider-key");
      expect(body).not.toContain("Authorization");
      expect(body).not.toContain("x-api-key");
    } finally {
      await testRuntime.dispose();
    }
  });
}
