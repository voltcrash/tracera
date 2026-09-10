import type { AiProvider, ExtractedClaim } from "../src/index.js";
import { extractClaims, scoreClaim } from "../src/index.js";
import type { EvaluationAdapter, EvaluationAdapterOptions } from "./adapter.js";
import { datasetHash, type AdapterRun, type EvaluationDataset } from "./schemas.js";

export function createV1EvaluationAdapter(provider: AiProvider): EvaluationAdapter {
  return {
    id: "tracera-v1",
    version: "1.0.0",
    async evaluate(dataset, options) {
      if (options.mode !== "live") throw new Error("The v1 adapter only executes in live mode.");
      return evaluateV1(provider, dataset, options);
    },
  };
}

async function evaluateV1(
  provider: AiProvider,
  dataset: EvaluationDataset,
  options: EvaluationAdapterOptions,
): Promise<AdapterRun> {
  const documents = dataset.documents.filter(
    (document) => options.split === "all" || document.splitId === options.split,
  );
  const predictions: AdapterRun["predictions"] = [];
  const extractionMatches: AdapterRun["extractionMatches"] = [];

  for (const document of documents) {
    const claims = await extractClaims(provider, document.text, { signal: options.signal });
    const goldClaims = dataset.claims.filter((claim) => claim.documentId === document.id);
    const usedPredictions = new Set<string>();

    for (const gold of goldClaims) {
      const match = findMatch(gold.text, claims, usedPredictions);
      extractionMatches.push({
        documentId: document.id,
        goldClaimId: gold.id,
        predictedClaimId: match?.claim.id ?? null,
        status: match ? match.status : "missed",
        method: match?.method ?? "human_review_required",
        rationale: match?.rationale ?? "No plausible extracted claim was found.",
      });
      if (!match || match.status === "unresolved") continue;
      usedPredictions.add(match.claim.id);
      const evidence = gold.evidenceExcerptIds.flatMap((excerptId) => {
        const excerpt = dataset.excerpts.find((item) => item.id === excerptId);
        const evidenceDocument = dataset.evidenceDocuments.find(
          (item) => item.id === excerpt?.evidenceDocumentId,
        );
        if (!excerpt || !evidenceDocument) return [];
        return [
          {
            id: excerpt.id,
            title: evidenceDocument.id,
            url: evidenceDocument.sourceUrl,
            snippet: excerpt.quote,
            credibility: 0.5,
            type: "google_fact_check" as const,
            sourceDomain: new URL(evidenceDocument.sourceUrl).hostname,
            similarity: 1,
          },
        ];
      });
      const startedAt = performance.now();
      const verdict = await scoreClaim(provider, match.claim, evidence, { signal: options.signal });
      predictions.push({
        claimId: gold.id,
        documentId: document.id,
        predictedText: match.claim.claimText,
        predictedSpan: locate(document.text, match.claim.claimText),
        label: verdict.verdict,
        confidence: null,
        citedExcerptIds: [
          ...verdict.supportingSources.map((source) => source.id),
          ...verdict.contradictingSources.map((source) => source.id),
        ],
        evidenceSufficient: evidence.length > 0,
        evidenceApplicable: evidence.length > 0,
        citationEntailmentCorrect: null,
        originCandidateCorrect: null,
        emittedGlobalOriginClaim: false,
        latencyMs: performance.now() - startedAt,
        costUsd: null,
      });
    }

    for (const claim of claims.filter((claim) => !usedPredictions.has(claim.id))) {
      extractionMatches.push({
        documentId: document.id,
        goldClaimId: null,
        predictedClaimId: claim.id,
        status: "unmatched_prediction",
        method: "human_review_required",
        rationale: "No automatic gold match; a human must determine semantic precision.",
      });
    }
  }

  return {
    adapterId: "tracera-v1",
    adapterVersion: "1.0.0",
    mode: "live",
    datasetId: dataset.datasetId,
    datasetHash: datasetHash(dataset),
    seed: options.seed,
    predictions,
    extractionMatches,
    outages: [],
  };
}

function findMatch(text: string, claims: ExtractedClaim[], used: Set<string>) {
  const exact = claims.find((claim) => !used.has(claim.id) && claim.claimText === text);
  if (exact) {
    return {
      claim: exact,
      status: "matched" as const,
      method: "exact_span" as const,
      rationale: "Extracted text exactly matches the adjudicated claim text.",
    };
  }
  const normalized = normalize(text);
  const normalizedMatch = claims.find(
    (claim) => !used.has(claim.id) && normalize(claim.claimText) === normalized,
  );
  if (normalizedMatch) {
    return {
      claim: normalizedMatch,
      status: "matched" as const,
      method: "normalized_text" as const,
      rationale: "Case and punctuation normalization produced an exact match.",
    };
  }
  const unresolved = claims.find((claim) => {
    if (used.has(claim.id)) return false;
    const left = new Set(normalize(claim.claimText).split(" "));
    const right = normalize(text).split(" ");
    return right.filter((token) => left.has(token)).length / Math.max(1, right.length) >= 0.6;
  });
  return unresolved
    ? {
        claim: unresolved,
        status: "unresolved" as const,
        method: "human_review_required" as const,
        rationale: "Lexical overlap is suggestive but cannot establish semantic equivalence.",
      }
    : undefined;
}

function normalize(text: string) {
  return text
    .toLocaleLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function locate(document: string, text: string) {
  const start = document.indexOf(text);
  return start < 0 ? null : { start, end: start + text.length };
}
