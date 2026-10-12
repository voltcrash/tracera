import type { RawBlobStore } from "../../src/analysis/storage.js";
import type { AnalysisPorts, ClockPort, GenerationPort } from "../../src/analysis/types.js";
import type { ChunkPayload } from "../../src/analysis/claims/index.js";
import { createDocumentAcquisitionPort } from "../../src/analysis/ingestion/index.js";
import { createExistingDiscoveryAdapters } from "../../src/analysis/retrieval/index.js";
import { createScriptedClaimGeneration, scriptedClaim } from "./scripted-claim-generation.js";

export const FIXTURE_ARTICLE =
  "The city opened a public library in 2026. The library has 20000 books.";

export function createFixtureAnalysisPorts(input: {
  clock: ClockPort;
  rawBlobStore?: RawBlobStore;
}): Pick<AnalysisPorts, "generation" | "embeddings" | "search" | "documents"> {
  const generation: GenerationPort = {
    modelId: "scripted-claim-fixture",
    promptVersion: "tracera-test-fixture-prompts-1.0.0",
    async generate(request) {
      const payload = JSON.parse(request.untrustedContent[0]!.text) as ChunkPayload;
      const claims = payload.segments
        .filter(({ role, text }) => role === "extract" && text.trim().length > 0)
        .map(({ text }) =>
          scriptedClaim({
            text,
            sourceQuotes: [text],
            time: { statedText: text.match(/\b(?:19|20)\d{2}\b/g)?.join(", ") ?? null },
          }),
        );
      return createScriptedClaimGeneration(
        { segments: [], claims },
        { usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } },
      ).generate(request);
    },
  };
  return {
    generation,
    embeddings: {
      modelId: "test-fixture-embedding",
      dimensions: 1024,
      preprocessing: "tracera-normalized-text-1.0.0",
      async embed() {
        throw new Error("The focused engine does not use embeddings.");
      },
    },
    search: createExistingDiscoveryAdapters(
      { googleNews: { search: async () => ({ results: [], costUsd: 0 }) } },
      input.clock,
    ),
    documents: zeroCostDocuments(
      createDocumentAcquisitionPort({
        now: () => input.clock.now(),
        monotonicMs: () => input.clock.monotonicMs(),
        rawBlobStore: input.rawBlobStore,
        safeFetchOptions: {
          resolveHostAddresses: async () => ["93.184.216.34"],
          fetchImplementation: async () =>
            new Response(`<html><body><article><p>${FIXTURE_ARTICLE}</p></article></body></html>`, {
              headers: { "content-type": "text/html" },
            }),
        },
        ocrCostUsd: 0,
        ocr: {
          provider: "scripted-fixture",
          modelId: "fixture-ocr",
          async recognize({ signal }) {
            signal.throwIfAborted();
            return {
              regions: [
                {
                  text: FIXTURE_ARTICLE,
                  boundingBox: { page: 0, frameId: null, x: 0, y: 0, width: 1, height: 1 },
                  transcriptionUncertain: false,
                },
              ],
            };
          },
        },
      }),
    ),
  };
}

function zeroCostDocuments(port: ReturnType<typeof createDocumentAcquisitionPort>) {
  return {
    ...port,
    async acquire(request: Parameters<typeof port.acquire>[0]) {
      const result = await port.acquire(request);
      return { ...result, metrics: { ...result.metrics, costUsd: 0 } };
    },
  };
}
