import { CORE_V2_CONTRACT_VERSION, type ClaimV2, type Span } from "@repo/contracts/core-v2";
import type { EvaluationAdapter, EvaluationAdapterOptions } from "../../../evaluation/adapter.js";
import {
  datasetHash,
  type AdapterRun,
  type EvaluationDataset,
} from "../../../evaluation/schemas.js";
import type { ExtractClaimsV2, RunEnvironment } from "../types.js";
import { extractClaimsV2 } from "./extract-claims.js";

type ExtractionMatch = AdapterRun["extractionMatches"][number];
type GoldClaim = EvaluationDataset["claims"][number];

/**
 * Aligns an extracted inventory with the adjudicated inventory for one
 * document. Only gold spans and gold text decide a match; the extractor's own
 * coverage audit and dispositions are never consulted, so it cannot grade
 * itself. Anything short of exact span identity or identical text goes to
 * human review instead of counting as correct.
 */
export function matchInventoryToGold(input: {
  documentId: string;
  goldClaims: GoldClaim[];
  claims: ClaimV2[];
}): ExtractionMatch[] {
  const gold = input.goldClaims.filter((claim) => claim.documentId === input.documentId);
  const predicted = input.claims.filter((claim) => claim.duplicateOfClaimId === null);
  const goldKeyCounts = new Map<string, number>();
  for (const claim of gold) {
    const key = spanKey(claim.spans);
    goldKeyCounts.set(key, (goldKeyCounts.get(key) ?? 0) + 1);
  }
  const used = new Set<string>();
  const matches: ExtractionMatch[] = [];
  const entry = (
    goldClaimId: string | null,
    predictedClaimId: string | null,
    status: ExtractionMatch["status"],
    method: ExtractionMatch["method"],
    rationale: string,
  ) =>
    matches.push({
      documentId: input.documentId,
      goldClaimId,
      predictedClaimId,
      status,
      method,
      rationale,
    });

  for (const claim of gold) {
    const available = predicted.filter((candidate) => !used.has(candidate.id));
    const key = spanKey(claim.spans);
    const exact = available.filter(
      (candidate) =>
        spanKey(candidate.spans) === key ||
        spanKey([...candidate.spans, ...candidate.occurrenceSpans]) === key,
    );
    if (goldKeyCounts.get(key) === 1 && exact.length === 1) {
      used.add(exact[0]!.id);
      entry(
        claim.id,
        exact[0]!.id,
        "matched",
        "exact_span",
        "Extracted spans equal the gold spans.",
      );
      continue;
    }
    const sameText = available.filter(
      (candidate) =>
        fold(candidate.text) === fold(claim.text) && overlapsAny(candidate.spans, claim.spans),
    );
    if (sameText.length === 1) {
      used.add(sameText[0]!.id);
      entry(
        claim.id,
        sameText[0]!.id,
        "matched",
        "normalized_text",
        "Extracted text equals the gold text at an overlapping span.",
      );
      continue;
    }
    const overlapping = available.filter((candidate) =>
      overlapsAny([...candidate.spans, ...candidate.occurrenceSpans], claim.spans),
    );
    if (overlapping.length === 0) {
      entry(
        claim.id,
        null,
        "missed",
        "human_review_required",
        "No extracted claim overlaps the gold spans.",
      );
      continue;
    }
    for (const candidate of overlapping) {
      used.add(candidate.id);
      entry(
        claim.id,
        candidate.id,
        "unresolved",
        "human_review_required",
        "The extracted claim overlaps the gold spans, but span overlap cannot establish semantic equivalence.",
      );
    }
  }
  for (const candidate of predicted) {
    if (used.has(candidate.id)) continue;
    entry(
      null,
      candidate.id,
      "unmatched_prediction",
      "human_review_required",
      "No gold claim overlaps this extracted claim; a reviewer must decide whether it is a material omission from gold or a spurious claim.",
    );
  }
  return matches;
}

export interface ClaimExtractionAdapterOptions {
  id: string;
  version: string;
  modes: ReadonlyArray<EvaluationAdapterOptions["mode"]>;
  createEnvironment(
    document: EvaluationDataset["documents"][number],
    options: EvaluationAdapterOptions,
  ): RunEnvironment;
  extract?: ExtractClaimsV2;
}

/** Extraction-only v2 adapter. It emits no verdict predictions. */
export function createClaimExtractionAdapter(
  adapterOptions: ClaimExtractionAdapterOptions,
): EvaluationAdapter {
  const extract = adapterOptions.extract ?? extractClaimsV2;
  return {
    id: adapterOptions.id,
    version: adapterOptions.version,
    contractVersion: CORE_V2_CONTRACT_VERSION,
    async evaluate(dataset, options) {
      if (!adapterOptions.modes.includes(options.mode)) {
        throw new Error(`Adapter ${adapterOptions.id} does not support ${options.mode} mode.`);
      }
      const extractionMatches: ExtractionMatch[] = [];
      const outages: string[] = [];
      const documents = dataset.documents.filter(
        (document) => options.split === "all" || document.splitId === options.split,
      );
      for (const document of documents) {
        const goldClaims = dataset.claims.filter((claim) => claim.documentId === document.id);
        const missAll = (reason: string) => {
          outages.push(`${document.id}: ${reason}`);
          for (const claim of goldClaims) {
            extractionMatches.push({
              documentId: document.id,
              goldClaimId: claim.id,
              predictedClaimId: null,
              status: "missed",
              method: "human_review_required",
              rationale: reason,
            });
          }
        };
        const environment = adapterOptions.createEnvironment(document, options);
        const acquired = await environment.ports.documents.acquireFromText({
          text: document.text,
          role: "submitted_input",
          signal: environment.signal,
        });
        const snapshot = acquired.data?.snapshot;
        if (!snapshot || snapshot.normalizedText !== document.text) {
          missAll(
            "the acquired snapshot text differs from the dataset text, so gold offsets do not apply",
          );
          continue;
        }
        await environment.ports.snapshots.put(snapshot, environment.signal);
        const result = await extract(
          { snapshots: [snapshot], primarySnapshotId: snapshot.id },
          environment,
        );
        if (!result.data) {
          missAll(
            `extraction ${result.status}: ${result.issues.map((issue) => issue.code).join(", ")}`,
          );
          continue;
        }
        if (result.status !== "complete") {
          outages.push(
            `${document.id}: extraction partial: ${[...new Set(result.issues.map((issue) => issue.code))].join(", ")}`,
          );
        }
        extractionMatches.push(
          ...matchInventoryToGold({
            documentId: document.id,
            goldClaims,
            claims: result.data.claims,
          }),
        );
      }
      return {
        adapterId: adapterOptions.id,
        adapterVersion: adapterOptions.version,
        mode: options.mode,
        datasetId: dataset.datasetId,
        datasetHash: datasetHash(dataset),
        seed: options.seed,
        predictions: [],
        extractionMatches,
        outages,
      };
    },
  };
}

function spanKey(spans: Span[]) {
  return [...spans]
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .map((span) => `${span.start}:${span.end}`)
    .join(",");
}

function overlapsAny(left: Span[], right: Span[]) {
  return left.some((a) => right.some((b) => a.start < b.end && b.start < a.end));
}

function fold(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
