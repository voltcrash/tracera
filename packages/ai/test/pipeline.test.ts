import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateScore,
  extractClaims,
  scoreClaim,
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
            claimText: "A public agency announced a policy on 2 February with $1 million funding.",
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
  assert.deepEqual(claims.map((item) => item.id), ["claim-1"]);
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
