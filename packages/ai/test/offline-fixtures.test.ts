import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { z } from "zod";
import {
  analyzeFraming,
  createAiProvider,
  extractClaims,
  FixtureProviderError,
  FixtureUnavailableError,
  normalizeOfflineFixtureInput,
  OFFLINE_FIXTURE_IMAGE,
  OFFLINE_FIXTURE_URL,
  OFFLINE_INACCESSIBLE_URL,
  retrieveOfflineFixtureArchiveHistory,
  retrieveOfflineFixtureSources,
  scoreClaim,
  writeHeadline,
} from "../src/index.js";

const coffee =
  "A new study found that drinking coffee after 2pm doubles the risk of insomnia for all adults.";

test("offline text generation, retrieval, scoring, and embeddings are deterministic without fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("External networking is denied in fixture tests.");
  };
  try {
    const provider = createAiProvider({ provider: "fixture" });
    const normalized = normalizeOfflineFixtureInput({ text: coffee });
    const [claims, framing, headline, firstEmbedding, secondEmbedding] = await Promise.all([
      extractClaims(provider, normalized.text),
      analyzeFraming(provider, normalized.text),
      writeHeadline(provider, normalized),
      provider.embed(normalized.text),
      provider.embed(normalized.text),
    ]);
    const sources = retrieveOfflineFixtureSources(claims[0]!);
    const verdict = await scoreClaim(provider, claims[0]!, sources);

    assert.equal(headline, "Coffee timing and insomnia risk");
    assert.equal(verdict.verdict, "supported");
    assert.equal(sources.length, 1);
    assert.equal(firstEmbedding.length, 1024);
    assert.deepEqual(firstEmbedding, secondEmbedding);
    assert.equal(framing.findings.length, 0);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("offline link, image, inaccessible, and conflicting fixtures are explicit", async () => {
  const provider = createAiProvider({ provider: "fixture" });
  const link = normalizeOfflineFixtureInput({ url: OFFLINE_FIXTURE_URL });
  const image = normalizeOfflineFixtureInput({
    image: OFFLINE_FIXTURE_IMAGE,
    imageMimeType: "image/png",
  });
  const conflict = normalizeOfflineFixtureInput({
    text: "Harbor City planted 10,000 trees during 2025, according to its annual report.",
  });
  const [linkClaims, imageClaims, conflictClaims] = await Promise.all([
    extractClaims(provider, link.text),
    extractClaims(provider, image.text),
    extractClaims(provider, conflict.text),
  ]);
  const conflictSources = retrieveOfflineFixtureSources(conflictClaims[0]!);
  const conflictVerdict = await scoreClaim(provider, conflictClaims[0]!, conflictSources);

  assert.equal(link.inputType, "link");
  assert.equal(image.inputType, "image");
  assert.equal(linkClaims.length, 1);
  assert.equal(imageClaims.length, 1);
  assert.equal(conflictVerdict.verdict, "mixed");
  assert.equal(conflictVerdict.sourceConflict, true);
  assert.equal(retrieveOfflineFixtureArchiveHistory(conflictSources).length, 1);
  assert.throws(
    () => normalizeOfflineFixtureInput({ url: OFFLINE_INACCESSIBLE_URL }),
    FixtureUnavailableError,
  );
  assert.throws(
    () => normalizeOfflineFixtureInput({ text: "An unknown local scenario." }),
    FixtureUnavailableError,
  );
});

test("provider failures never fall back to a live adapter", async () => {
  const provider = createAiProvider({ provider: "fixture" });
  await assert.rejects(
    extractClaims(
      provider,
      "Fixture provider failure: Atlas Transit added two electric buses in 2026.",
    ),
    FixtureProviderError,
  );
  await assert.rejects(
    provider.generateFromImage(
      "Transcribe",
      { data: "data:image/png;base64,dW5rbm93bg==", mimeType: "image/png" },
      z.object({ text: z.string() }),
    ),
    FixtureUnavailableError,
  );
});
