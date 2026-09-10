import { claimLabelSchema } from "@repo/contracts/core-v2";
import { z } from "zod";

export const splitIdSchema = z.enum(["development", "calibration", "test", "temporal"]);
/** Truth labels are the frozen v2 claim labels; the harness never defines its own. */
export const truthLabelSchema = claimLabelSchema;

const halfOpenSpanSchema = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
  .refine(({ start, end }) => start < end, "Span end must be greater than start.");

const annotationSchema = z.object({
  annotatorId: z.string().min(1),
  label: truthLabelSchema.nullable(),
  claimText: z.string().min(1),
  notes: z.string(),
});

export const evaluationDatasetSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    datasetId: z.string().min(1),
    datasetVersion: z.string().min(1),
    license: z.object({
      name: z.string().min(1),
      url: z.string().url().nullable(),
      redistributionAllowed: z.boolean(),
      notes: z.string(),
    }),
    documents: z.array(
      z.object({
        id: z.string().min(1),
        text: z.string(),
        contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        language: z.string().min(2),
        asOfTime: z.string().datetime({ offset: true }),
        acquiredAt: z.string().datetime({ offset: true }),
        sourceUrl: z.string().url().nullable(),
        splitId: splitIdSchema,
        eventGroupId: z.string().min(1),
        sourceFamilyId: z.string().min(1),
      }),
    ),
    evidenceDocuments: z.array(
      z.object({
        id: z.string().min(1),
        text: z.string(),
        contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        acquiredAt: z.string().datetime({ offset: true }),
        publishedAt: z.string().datetime({ offset: true }).nullable(),
        sourceUrl: z.string().url(),
        license: z.string().min(1),
      }),
    ),
    excerpts: z.array(
      z.object({
        id: z.string().min(1),
        evidenceDocumentId: z.string().min(1),
        span: halfOpenSpanSchema,
        quote: z.string().min(1),
      }),
    ),
    claims: z.array(
      z.object({
        id: z.string().min(1),
        documentId: z.string().min(1),
        text: z.string().min(1),
        spans: z.array(halfOpenSpanSchema).min(1),
        material: z.boolean(),
        checkability: z.enum(["checkable", "unanswerable", "non_factual"]),
        label: truthLabelSchema.nullable(),
        evidenceExcerptIds: z.array(z.string()),
        origin: z.enum(["known_root", "multiple_roots", "uncertain", "not_applicable"]),
        goldStatus: z.enum(["adjudicated_human", "synthetic", "model_labeled", "candidate"]),
        annotations: z.array(annotationSchema),
        adjudication: z
          .object({
            adjudicatorId: z.string().min(1),
            decidedAt: z.string().datetime({ offset: true }),
            resolution: z.string().min(1),
          })
          .nullable(),
      }),
    ),
  })
  .superRefine((dataset, context) => {
    validateUniqueIds(dataset.documents, "documents", context);
    validateUniqueIds(dataset.evidenceDocuments, "evidenceDocuments", context);
    validateUniqueIds(dataset.excerpts, "excerpts", context);
    validateUniqueIds(dataset.claims, "claims", context);

    const documents = new Map(dataset.documents.map((document) => [document.id, document]));
    const evidence = new Map(dataset.evidenceDocuments.map((document) => [document.id, document]));
    const excerpts = new Map(dataset.excerpts.map((excerpt) => [excerpt.id, excerpt]));
    for (const [index, document] of dataset.documents.entries()) {
      validateHash(
        document.text,
        document.contentHash,
        ["documents", index, "contentHash"],
        context,
      );
    }
    for (const [index, document] of dataset.evidenceDocuments.entries()) {
      validateHash(
        document.text,
        document.contentHash,
        ["evidenceDocuments", index, "contentHash"],
        context,
      );
    }
    for (const [index, excerpt] of dataset.excerpts.entries()) {
      const document = evidence.get(excerpt.evidenceDocumentId);
      if (!document) {
        addIssue(context, ["excerpts", index, "evidenceDocumentId"], "Unknown evidence document.");
      } else if (document.text.slice(excerpt.span.start, excerpt.span.end) !== excerpt.quote) {
        addIssue(context, ["excerpts", index, "span"], "Excerpt offsets do not match quote.");
      }
    }
    for (const [index, claim] of dataset.claims.entries()) {
      const document = documents.get(claim.documentId);
      if (!document) {
        addIssue(context, ["claims", index, "documentId"], "Unknown input document.");
      } else if (
        !claim.spans.some((span) => document.text.slice(span.start, span.end) === claim.text)
      ) {
        addIssue(context, ["claims", index, "spans"], "No claim span exactly matches claim text.");
      }
      for (const excerptId of claim.evidenceExcerptIds) {
        if (!excerpts.has(excerptId)) {
          addIssue(context, ["claims", index, "evidenceExcerptIds"], "Unknown evidence excerpt.");
        }
      }
      if (claim.goldStatus === "adjudicated_human") {
        if (claim.annotations.length < 2 || !claim.adjudication || !claim.label) {
          addIssue(
            context,
            ["claims", index, "goldStatus"],
            "Human gold requires two annotations, adjudication, and a label.",
          );
        }
      }
    }
  });

export const predictionSchema = z.object({
  claimId: z.string().min(1),
  documentId: z.string().min(1),
  predictedText: z.string().min(1),
  predictedSpan: halfOpenSpanSchema.nullable(),
  label: truthLabelSchema,
  confidence: z.number().min(0).max(1).nullable(),
  citedExcerptIds: z.array(z.string()),
  evidenceSufficient: z.boolean(),
  evidenceApplicable: z.boolean(),
  citationEntailmentCorrect: z.boolean().nullable(),
  originCandidateCorrect: z.boolean().nullable(),
  emittedGlobalOriginClaim: z.boolean(),
  latencyMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
});

export const adapterRunSchema = z.object({
  adapterId: z.string().min(1),
  adapterVersion: z.string().min(1),
  mode: z.enum(["fixture", "replay", "live"]),
  datasetId: z.string().min(1),
  datasetHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  seed: z.number().int().nonnegative(),
  predictions: z.array(predictionSchema),
  extractionMatches: z.array(
    z.object({
      documentId: z.string().min(1),
      goldClaimId: z.string().min(1).nullable(),
      predictedClaimId: z.string().min(1).nullable(),
      status: z.enum(["matched", "missed", "unresolved", "unmatched_prediction"]),
      method: z.enum(["exact_span", "normalized_text", "human_review_required"]),
      rationale: z.string().min(1),
    }),
  ),
  outages: z.array(z.string()),
});

export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>;
export type AdapterRun = z.infer<typeof adapterRunSchema>;
export type EvaluationPrediction = z.infer<typeof predictionSchema>;
export type EvaluationSplit = z.infer<typeof splitIdSchema>;
export type TruthLabel = z.infer<typeof truthLabelSchema>;

export function contentHash(content: string) {
  return `sha256:${sha256(content)}`;
}

export function datasetHash(dataset: EvaluationDataset) {
  return contentHash(JSON.stringify(canonicalize(dataset)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function validateUniqueIds(values: Array<{ id: string }>, path: string, context: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value.id)) addIssue(context, [path, index, "id"], "Duplicate ID.");
    seen.add(value.id);
  }
}

function validateHash(
  text: string,
  hash: string,
  path: Array<string | number>,
  context: z.RefinementCtx,
) {
  if (contentHash(text) !== hash) addIssue(context, path, "Content hash mismatch.");
}

function addIssue(context: z.RefinementCtx, path: Array<string | number>, message: string) {
  context.addIssue({ code: "custom", path, message });
}

function sha256(content: string) {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const input = new TextEncoder().encode(content);
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const lengthView = new DataView(bytes.buffer);
  lengthView.setUint32(paddedLength - 8, Math.floor(bitLength / 4_294_967_296), false);
  lengthView.setUint32(paddedLength - 4, bitLength, false);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const view = new DataView(bytes.buffer, offset, 64);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15] ?? 0;
      const previous2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e ?? 0, 6) ^ rotateRight(e ?? 0, 11) ^ rotateRight(e ?? 0, 25);
      const choice = ((e ?? 0) & (f ?? 0)) ^ (~(e ?? 0) & (g ?? 0));
      const temporary1 =
        ((h ?? 0) + sum1 + choice + (constants[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a ?? 0, 2) ^ rotateRight(a ?? 0, 13) ^ rotateRight(a ?? 0, 22);
      const majority = ((a ?? 0) & (b ?? 0)) ^ ((a ?? 0) & (c ?? 0)) ^ ((b ?? 0) & (c ?? 0));
      const temporary2 = (sum0 + majority) >>> 0;
      [a, b, c, d, e, f, g, h] = [
        (temporary1 + temporary2) >>> 0,
        a,
        b,
        c,
        ((d ?? 0) + temporary1) >>> 0,
        e,
        f,
        g,
      ];
    }
    const values = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < state.length; index += 1)
      state[index] = ((state[index] ?? 0) + (values[index] ?? 0)) >>> 0;
  }
  return state.map((value) => value.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, count: number) {
  return (value >>> count) | (value << (32 - count));
}
