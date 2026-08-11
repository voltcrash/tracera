import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateScore,
  analyzeFraming,
  extractClaims,
  normalizeInput,
  retrieveSources,
  scoreClaim,
  traceGroundZero,
  type AiProvider,
  type ClaimVerdict,
} from "../src/index.js";
import { extractExifMetadata } from "../src/pipeline/image-metadata.js";
import {
  articleTitleFromUrl,
  isReaderErrorDocument,
  isReadableArticleText,
  parseReaderDocument,
} from "../src/pipeline/normalize-input.js";

const claim = {
  id: "claim-1",
  claimText: "A public agency announced a policy on 1 January.",
  claimType: "factual_assertion" as const,
  checkability: "checkable" as const,
  context: "A short test claim.",
};

test("reader fallback preserves article text and provenance metadata", () => {
  const article = parseReaderDocument(`Title: Example report
URL Source: https://news.example/report
Published Time: 2026-08-10T14:47:38+05:30
Author: Example Reporter

Markdown Content:
# Example report

Officials published enough readable article text for a fact-check.`);

  assert.equal(
    article.text,
    "# Example report\n\nOfficials published enough readable article text for a fact-check.",
  );
  assert.equal(article.publishedAt, "2026-08-10T14:47:38+05:30");
  assert.equal(article.author, "Example Reporter");
});

test("reader fallback rejects image captions and recovers a headline from an article URL", () => {
  assert.equal(
    isReadableArticleText("A man sitting inside an airplane cabin."),
    false,
  );
  assert.equal(
    articleTitleFromUrl(
      new URL(
        "https://www.ndtv.com/india-news/air-india-pilot-who-flew-turbulence-hit-flight-fails-2nd-dope-test-sources-11895474",
      ),
    ),
    "Air india pilot who flew turbulence hit flight fails 2nd dope test sources",
  );
  assert.equal(
    articleTitleFromUrl(new URL("https://example.com/article/11895474")),
    undefined,
  );
  assert.equal(
    articleTitleFromUrl(
      new URL(
        "https://timesofindia.indiatimes.com/india/phuket-delhi-ai-flight-captains-confirmatory-test-also-positive-sources/articleshow/133155633.cms",
      ),
    ),
    "Phuket delhi ai flight captains confirmatory test also positive sources",
  );
});

test("reader error shells are rejected before headline fallback", () => {
  const article = parseReaderDocument(
    `Title: Page Not Found
URL Source: https://example.com/air-india-pilot-confirmatory-test-positive-133155633.cms
Warning: Target URL returned error 404: Not Found

Markdown Content:
This is a long navigation shell that must not be treated as article text. `.repeat(
      8,
    ),
  );
  assert.equal(isReadableArticleText(article.text), true);
  assert.equal(isReaderErrorDocument(article), true);
});

test("claim extraction discards model claims that introduce unsupported details", async () => {
  const provider: AiProvider = {
    async generate() {
      return {
        claims: [
          claim,
          {
            ...claim,
            id: "invented",
            claimText:
              "A public agency announced a policy on 2 February with $1 million funding.",
          },
        ],
      } as never;
    },
    async embed() {
      return [];
    },
    async generateFromImage() {
      throw new Error("Image generation is not used in this test.");
    },
  };

  const claims = await extractClaims(
    provider,
    "A public agency announced a policy on 1 January.",
  );
  assert.deepEqual(
    claims.map((item) => item.id),
    ["claim-1"],
  );
});

test("a recovered publisher headline remains checkable when the model returns no claims", async () => {
  const provider: AiProvider = {
    async generate() {
      return { claims: [] } as never;
    },
    async generateFromImage() {
      throw new Error("Image generation is not used in claim extraction.");
    },
    async embed() {
      return [];
    },
  };
  const claims = await extractClaims(
    provider,
    "Headline: Phuket delhi ai flight captains confirmatory test also positive sources",
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.id, "recovered-headline");
  assert.equal(
    claims[0]?.claimText,
    "Phuket delhi ai flight captains confirmatory test also positive sources",
  );
});

test("an empty evidence set remains explicitly unverified", async () => {
  const provider: AiProvider = {
    async generate() {
      throw new Error("The model must not be called without evidence.");
    },
    async embed() {
      return [];
    },
    async generateFromImage() {
      throw new Error("Image generation is not used in this test.");
    },
  };

  const result = await scoreClaim(provider, claim, []);
  assert.equal(result.verdict, "unverified");
  assert.equal(result.confidence, 0.2);
  assert.equal(result.evidenceQuality, 0);
});

test("evidence retrieval respects the Worker subrequest budget", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let requests = 0;
  console.warn = () => undefined;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const provider: AiProvider = {
    async generate() {
      throw new Error("Text generation is not used during retrieval.");
    },
    async generateFromImage() {
      throw new Error("Image generation is not used during retrieval.");
    },
    async embed() {
      return Array.from({ length: 1024 }, () => 0);
    },
  };

  try {
    const sources = await retrieveSources(claim, {
      provider,
      claimEmbedding: Array.from({ length: 1024 }, () => 0),
      // Avoid a real corpus query; the retrieval layer treats this invalid
      // optional source just like any other unavailable provider.
      corpusLimit: 0,
      factCheckApiKey: "test-fact-check-key",
      newsApiKey: "test-news-key",
      webSearchEndpoint: "https://search.example.test",
      webSearchApiKey: "test-search-key",
      externalRequestLimit: 2,
    });

    assert.deepEqual(sources, []);
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("Google News retrieval keeps contextual short claims on the story subject", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const requestedHosts: string[] = [];
  console.warn = () => undefined;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedHosts.push(url.hostname);
    if (url.hostname === "news.google.com") {
      return new Response(`<?xml version="1.0"?><rss><channel><item>
        <title>17 people hospitalized after Air India Phuket-Delhi flight incident</title>
        <link>https://news.google.com/rss/articles/relevant?oc=5</link>
        <pubDate>Tue, 11 Aug 2026 12:33:28 GMT</pubDate>
        <description>Independent reporting says 17 people were hospitalized.</description>
        <source url="https://reliable.example">Reliable News</source>
      </item></channel></rss>`);
    }
    return new Response(
      '<html><head><meta name="description" content="Seventeen people were hospitalized after the Air India flight incident."></head></html>',
      { headers: { "content-type": "text/html" } },
    );
  };
  const provider: AiProvider = {
    async generate() {
      throw new Error("Text generation is not used during retrieval.");
    },
    async generateFromImage() {
      throw new Error("Image generation is not used during retrieval.");
    },
    async embed() {
      return Array.from({ length: 1024 }, () => 0);
    },
  };
  const contextualClaim = {
    ...claim,
    claimText: "Seventeen people were hospitalised following the incident.",
    context: "The incident involved an Air India Phuket-Delhi flight.",
  };

  try {
    const sources = await retrieveSources(contextualClaim, {
      provider,
      claimEmbedding: Array.from({ length: 1024 }, () => 0),
      corpusLimit: 0,
      storyContext:
        "Air India Phuket-Delhi flight lost altitude and passengers were taken to hospital.",
      externalRequestLimit: 3,
    });
    assert.equal(requestedHosts[0], "news.google.com");
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.publisher, "Reliable News");
    assert.ok((sources[0]?.similarity ?? 0) >= 0.24);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("the Tracera Score retains evidence and source signals separately", () => {
  const verdict: ClaimVerdict = {
    claim,
    verdict: "supported",
    confidence: 0.9,
    reasoning: ["A source supports it."],
    consideredSources: [
      {
        id: "source-1",
        type: "web_search",
        title: "Independent evidence",
        credibility: 0.9,
        publishedAt: new Date().toISOString(),
      },
    ],
    supportingSources: [
      {
        id: "source-1",
        type: "web_search",
        title: "Independent evidence",
        credibility: 0.9,
        publishedAt: new Date().toISOString(),
      },
    ],
    contradictingSources: [],
    sourceConflict: false,
    evidenceQuality: 0.7,
  };

  const score = aggregateScore([verdict]);
  assert.equal(score.factualAccuracy.score, 100);
  assert.equal(score.evidenceQuality.score, 70);
  assert.equal(score.sourceReputation.score, 90);
  assert.equal(score.recency.flag, "current");
});

test("article-level framing analysis drives the framing dimension", async () => {
  const provider: AiProvider = {
    async generate() {
      return {
        emotionalLanguageLevel: 0.8,
        factualSkewLevel: 0.6,
        contextOmissionRisk: 0.5,
        findings: ["The headline uses an inflammatory label."],
      } as never;
    },
    async generateFromImage() {
      throw new Error("Image generation is not used in this test.");
    },
    async embed() {
      return [];
    },
  };
  const framing = await analyzeFraming(
    provider,
    "A shocking report calls researchers traitors without supplying context.",
  );
  assert.equal(framing.integrityScore, 0.34);

  const score = aggregateScore([], framing);
  assert.equal(score.framingManipulation.score, 34);
});

test("image normalization sends the actual image through the multimodal provider", async () => {
  const image = "data:image/png;base64,aGVsbG8=";
  let receivedImage: string | undefined;
  const provider: AiProvider = {
    async generate() {
      throw new Error("Text generation is not used for image OCR.");
    },
    async generateFromImage(_prompt, input) {
      receivedImage = input.data;
      return { text: "Visible headline" } as never;
    },
    async embed() {
      return [];
    },
  };

  const normalized = await normalizeInput(
    { image, imageMimeType: "image/png" },
    provider,
  );
  assert.equal(receivedImage, image);
  assert.equal(normalized.text, "Visible headline");
  assert.equal(normalized.imageMetadata?.ocrProvider, "model_fallback");
});

test("JPEG EXIF metadata is extracted without trusting malformed binary data", () => {
  const tiff = Buffer.alloc(44);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x010f, 10);
  tiff.writeUInt16LE(2, 12);
  tiff.writeUInt32LE(6, 14);
  tiff.writeUInt32LE(38, 18);
  tiff.writeUInt16LE(0x0112, 22);
  tiff.writeUInt16LE(3, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt16LE(6, 30);
  tiff.writeUInt32LE(0, 34);
  tiff.write("Canon\0", 38, "ascii");
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, payload.length + 2]),
    payload,
    Buffer.from([0xff, 0xd9]),
  ]);
  const metadata = extractExifMetadata(
    `data:image/jpeg;base64,${jpeg.toString("base64")}`,
  );
  assert.deepEqual(metadata, { "Camera make": "Canon", Orientation: "6" });
  assert.equal(
    extractExifMetadata("data:image/jpeg;base64,bm90LWEtanBlZw=="),
    undefined,
  );
});

test("Ground Zero distinguishes a canonical repost and an explicit citation", () => {
  const result = traceGroundZero([
    {
      id: "origin",
      type: "newsapi",
      title: "Original report",
      url: "https://publisher.example/story",
      canonicalUrl: "https://publisher.example/story",
      sourceDomain: "publisher.example",
      publishedAt: "2026-01-01T10:00:00Z",
      publisherPublishedAt: "2026-01-01T10:00:00Z",
    },
    {
      id: "repost",
      type: "google_news_rss",
      title: "Syndicated report",
      url: "https://aggregator.example/story?utm_source=test",
      canonicalUrl: "https://publisher.example/story",
      sourceDomain: "aggregator.example",
      publishedAt: "2026-01-01T11:00:00Z",
    },
    {
      id: "followup",
      type: "publisher_rss",
      title: "Follow-up",
      url: "https://second.example/follow-up",
      sourceDomain: "second.example",
      publishedAt: "2026-01-01T12:00:00Z",
      citedUrls: ["https://publisher.example/story?utm_campaign=followup"],
    },
  ]);

  assert.equal(result.earliestSource?.id, "origin");
  assert.equal(result.confidence, "moderate");
  assert.deepEqual(
    result.relationships.map((item) => item.relation),
    ["publisher", "repost", "cites_earlier_source"],
  );
});

test("Ground Zero lowers confidence for index dates and citation chronology conflicts", () => {
  const result = traceGroundZero(
    [
      {
        id: "indexed-earliest",
        type: "web_search",
        title: "Search-index candidate",
        url: "https://one.example/story",
        sourceDomain: "one.example",
        publishedAt: "2026-01-01T10:00:00Z",
      },
      {
        id: "middle",
        type: "newsapi",
        title: "Middle report",
        url: "https://two.example/story",
        sourceDomain: "two.example",
        publishedAt: "2026-01-01T11:00:00Z",
        publisherPublishedAt: "2026-01-01T11:00:00Z",
        citedUrls: ["https://three.example/story"],
      },
      {
        id: "future-target",
        type: "publisher_rss",
        title: "Later declared report",
        url: "https://three.example/story",
        sourceDomain: "three.example",
        publishedAt: "2026-01-01T12:00:00Z",
        publisherPublishedAt: "2026-01-01T12:00:00Z",
      },
    ],
    [],
    [
      {
        url: "https://one.example/story",
        firstSeenAt: "2026-01-02T00:00:00Z",
        archivedUrl:
          "https://web.archive.org/web/20260102000000/https://one.example/story",
      },
    ],
  );

  assert.equal(result.confidence, "low");
  assert.ok(
    result.relationships.some(
      (relationship) => relationship.relation === "chronology_conflict",
    ),
  );
  assert.ok(
    result.signals.some((signal) => signal.includes("web archive capture")),
  );
});
