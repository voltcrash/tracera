import { Response } from "miniflare";
import { expect, test } from "vite-plus/test";
import type { DocumentSnapshot } from "@repo/contracts/analysis";
import { createWorkerRuntime } from "./support/workerd-runtime";

test("workerd ingests public HTML through DNS-validated Web fetch and stores the raw bytes in R2", async () => {
  const html =
    '<html lang="en"><title>Evidence</title><body><article><h1>Results</h1><p>Revenue increased 12%.</p><table><tr><td>2026</td><td>120</td></tr></table></article></body></html>';
  const testRuntime = await createWorkerRuntime(async (request) => {
    expect(request.url).toBe("https://news.example/article");
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  });
  try {
    const response = await testRuntime.runtime.dispatchFetch(
      "http://worker/ingest?url=https%3A%2F%2Fnews.example%2Farticle",
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      status: string;
      data: { snapshot: DocumentSnapshot };
    };
    expect(result.status, JSON.stringify({ result, requests: testRuntime.requests })).toBe(
      "complete",
    );
    expect(result.data.snapshot.normalizedText).toContain("Revenue increased 12%.");
    expect(result.data.snapshot.normalizedText).toContain("2026");
    expect(result.data.snapshot.blobLocator.uri).toMatch(
      /^r2:\/\/snapshots\/snap_[a-f0-9]+\/[a-f0-9]{64}$/,
    );
    const raw = await testRuntime.runtime.dispatchFetch(
      `http://worker/raw?uri=${encodeURIComponent(result.data.snapshot.blobLocator.uri!)}`,
    );
    expect(await raw.text()).toBe(html);
    expect(testRuntime.requests.filter((url) => url.includes("dns-query"))).toHaveLength(2);
    const inputs = Object.keys(testRuntime.bundle.metafile!.inputs);
    expect(inputs.some((path) => path.includes("cheerio/dist/browser"))).toBe(true);
    expect(inputs.some((path) => /undici|node-fetch|filesystem-raw-blob-store/.test(path))).toBe(
      false,
    );
    expect(testRuntime.bundle.outputFiles[0]!.text).not.toMatch(
      /from ["']node:(http|https|net|stream)["']/,
    );
  } finally {
    await testRuntime.dispose();
  }
});
