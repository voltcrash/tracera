import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateScore,
  extractClaims,
  scoreClaim,
  traceGroundZero,
  type AiProvider,
  type ClaimVerdict,
} from "../src/index.js";

const claim = {
  id: "claim-1",
  claimText: "A public agency announced a policy on 1 January.",
  claimType: "factual_assertion" as const,
  checkability: "checkable" as const,
  context: "A short test claim.",
};

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

test("an empty evidence set remains explicitly unverified", async () => {
  const provider: AiProvider = {
    async generate() {
      throw new Error("The model must not be called without evidence.");
    },
    async embed() {
      return [];
    },
  };

  const result = await scoreClaim(provider, claim, []);
  assert.equal(result.verdict, "unverified");
  assert.equal(result.confidence, 0.2);
  assert.equal(result.evidenceQuality, 0);
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
