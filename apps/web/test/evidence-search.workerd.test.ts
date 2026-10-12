import { fileURLToPath } from "node:url";
import { bundleTestWorker } from "@repo/ai/test-bundler";
import {
  createTestRuntime,
  Response,
  type Request as MiniflareRequest,
} from "@repo/db/test-runtime";
import { expect, test } from "vite-plus/test";

const source = `
import { createLiveSearchPorts } from "../../src/server/evidence-search.server";
import { createSystemClock } from "@repo/ai/analysis";
import { createDocumentAcquisitionPort, createR2RawBlobStore } from "@repo/ai/analysis/ingestion";
export default {
  async fetch(request, env) {
    const clock = createSystemClock();
    if (new URL(request.url).pathname === "/search") {
      const results = await Promise.all(createLiveSearchPorts(env, clock).map(async port => ({ provider: port.provider, result: await port.search({ query: "The city opened a library", intent: "supporting", claimId: "claim_fixture", limit: 5, dateRange: null, signal: request.signal }) })));
      return Response.json(results);
    }
    const rawBlobStore = createR2RawBlobStore(env.BLOBS);
    const port = createDocumentAcquisitionPort({ now: clock.now, monotonicMs: clock.monotonicMs, rawBlobStore });
    const acquired = await port.acquire({ url: "https://evidence.example/library", role: "evidence", maxBytes: 5000000, signal: request.signal });
    const snapshot = acquired.data.snapshot;
    const bytes = await rawBlobStore.read(snapshot.blobLocator.uri, request.signal);
    return Response.json({ snapshot, raw: new TextDecoder().decode(bytes) });
  }
};`;

async function harness(optionalKeys = true, unavailable = false) {
  const requests: { host: string; headers: Headers; key: string | null }[] = [];
  const html =
    "<html><body><article><p>The city opened a public library in 2026.</p></article></body></html>";
  const runtime = await createTestRuntime({
    script: await bundleTestWorker(source, fileURLToPath(new URL("./support/", import.meta.url))),
    bindings: optionalKeys
      ? {
          GOOGLE_FACT_CHECK_API_KEY: "synthetic-fact-check-key",
          NEWS_API_KEY: "synthetic-news-key",
        }
      : {},
    outboundService: async (request: MiniflareRequest) => {
      const url = new URL(request.url);
      if (url.hostname === "cloudflare-dns.com" || url.hostname === "1.1.1.1") {
        const ipv6 = ["AAAA", "28"].includes(url.searchParams.get("type") ?? "");
        return Response.json({
          Status: 0,
          Question: [{ name: url.searchParams.get("name"), type: ipv6 ? 28 : 1 }],
          Answer: [
            {
              name: url.searchParams.get("name"),
              type: ipv6 ? 28 : 1,
              data: ipv6 ? "2001:4860:4860::8888" : "8.8.8.8",
              TTL: 60,
            },
          ],
        });
      }
      requests.push({
        host: url.hostname,
        headers: new Headers([...request.headers.entries()]),
        key: url.searchParams.get("key"),
      });
      if (unavailable) return new Response("blocked", { status: 503 });
      if (url.hostname === "news.google.com")
        return new Response(
          "<rss><channel><item><title>Library opening</title><link>https://evidence.example/library</link><description>City record</description></item></channel></rss>",
          { headers: { "content-type": "application/rss+xml" } },
        );
      if (url.hostname === "api.gdeltproject.org")
        return Response.json({
          articles: [
            {
              title: "Library opening",
              url: "https://evidence.example/library",
              domain: "evidence.example",
            },
          ],
        });
      if (url.hostname === "factchecktools.googleapis.com")
        return Response.json({
          claims: [
            {
              text: "The city opened a library",
              claimReview: [
                {
                  url: "https://evidence.example/fact-check",
                  title: "Library record",
                  publisher: { name: "City" },
                },
              ],
            },
          ],
        });
      if (url.hostname === "newsapi.org")
        return Response.json({
          articles: [
            {
              title: "Library opening",
              url: "https://evidence.example/library",
              description: "City record",
              source: { name: "City" },
            },
          ],
        });
      if (url.hostname === "evidence.example")
        return new Response(html, { headers: { "content-type": "text/html" } });
      throw new Error("Unexpected external request.");
    },
  });
  return { ...runtime, requests, html };
}

test("workerd discovery keeps all four sources and optional credential transports", async () => {
  const runtime = await harness();
  try {
    const response = await runtime.runtime.dispatchFetch("http://worker/search");
    const results = (await response.json()) as {
      provider: string;
      result: { status: string; data: { candidates: { evidenceEligibility: string }[] } };
    }[];
    expect(results.map(({ provider }) => provider).sort()).toEqual([
      "gdelt",
      "google-fact-check",
      "google-news",
      "news-api",
    ]);
    expect(
      results.every(
        ({ result }) => result.status === "complete" && result.data.candidates.length === 1,
      ),
    ).toBe(true);
    expect(JSON.stringify(results)).not.toContain("synthetic-");
    expect(runtime.requests.find(({ host }) => host === "factchecktools.googleapis.com")?.key).toBe(
      "synthetic-fact-check-key",
    );
    expect(
      runtime.requests.find(({ host }) => host === "newsapi.org")?.headers.get("x-api-key"),
    ).toBe("synthetic-news-key");
  } finally {
    await runtime.dispose();
  }
});

test("Fact Check and NewsAPI are omitted when their keys are absent", async () => {
  const runtime = await harness(false);
  try {
    const results = (await (
      await runtime.runtime.dispatchFetch("http://worker/search")
    ).json()) as { provider: string }[];
    expect(results.map(({ provider }) => provider).sort()).toEqual(["gdelt", "google-news"]);
    expect(runtime.requests.map(({ host }) => host).sort()).toEqual([
      "api.gdeltproject.org",
      "news.google.com",
    ]);
  } finally {
    await runtime.dispose();
  }
});

test("source outages remain unavailable evidence and do not expose optional keys", async () => {
  const runtime = await harness(true, true);
  try {
    const results = (await (
      await runtime.runtime.dispatchFetch("http://worker/search")
    ).json()) as { result: { status: string; data: unknown } }[];
    expect(results.every(({ result }) => result.status === "failed" && result.data === null)).toBe(
      true,
    );
    expect(JSON.stringify(results)).not.toContain("synthetic-");
  } finally {
    await runtime.dispose();
  }
});

test("real Worker acquisition keeps the acquired evidence bytes in R2", async () => {
  const runtime = await harness();
  try {
    const result = (await (
      await runtime.runtime.dispatchFetch("http://worker/evidence")
    ).json()) as {
      snapshot: { normalizedText: string; blobLocator: { status: string; uri: string } };
      raw: string;
    };
    expect(result.raw).toBe(runtime.html);
    expect(result.snapshot.normalizedText).toBe("The city opened a public library in 2026.");
    expect(result.snapshot.blobLocator.status).toBe("stored");
    expect(result.snapshot.blobLocator.uri).toMatch(/^r2:\/\/snapshots\//);
  } finally {
    await runtime.dispose();
  }
});
