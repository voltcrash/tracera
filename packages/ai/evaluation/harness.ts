import { computeMetrics } from "./metrics.js";
import {
  adapterRunSchema,
  datasetHash,
  evaluationDatasetSchema,
  type AdapterRun,
  type EvaluationDataset,
  type EvaluationSplit,
} from "./schemas.js";
import { validateSplitLeakage } from "./validation.js";

export function evaluateRun(
  sourceDataset: unknown,
  sourceRun: unknown,
  options: { split: EvaluationSplit | "all"; seed: number; baseline?: unknown },
) {
  const fullDataset = evaluationDatasetSchema.parse(sourceDataset);
  const run = adapterRunSchema.parse(sourceRun);
  const baseline = options.baseline ? adapterRunSchema.parse(options.baseline) : undefined;
  const dataset = selectSplit(fullDataset, options.split);
  const expectedHash = datasetHash(fullDataset);
  const integrityIssues = validateSplitLeakage(fullDataset);
  if (run.datasetHash !== expectedHash) {
    integrityIssues.push({
      code: "content_hash",
      message: "Adapter run dataset hash does not match the evaluated dataset.",
      ids: [run.datasetHash, expectedHash],
    });
  }
  return {
    dataset,
    datasetHash: expectedHash,
    datasetCounts: {
      documents: dataset.documents.length,
      claims: dataset.claims.length,
      humanGoldClaims: dataset.claims.filter((claim) => claim.goldStatus === "adjudicated_human")
        .length,
      syntheticClaims: dataset.claims.filter((claim) => claim.goldStatus === "synthetic").length,
    },
    integrityIssues,
    metrics: computeMetrics(dataset, run, baseline, options.seed),
  };
}

export function runInvariantFixture(dataset: EvaluationDataset, seed: number) {
  const cleanRun = syntheticRun(dataset, seed);
  const wrongVerdict = structuredClone(cleanRun);
  const target = wrongVerdict.predictions.find((prediction) => prediction.claimId === "claim-time");
  if (target) target.label = "contradicted";

  const invalidCitation = structuredClone(cleanRun);
  const citationTarget = invalidCitation.predictions.find(
    (prediction) => prediction.claimId === "claim-time",
  );
  if (citationTarget) citationTarget.citedExcerptIds = ["invented-excerpt"];

  const futureDataset = structuredClone(dataset);
  const futureEvidence = futureDataset.evidenceDocuments.find(
    (document) => document.id === "evidence-rain",
  );
  if (futureEvidence) futureEvidence.acquiredAt = "2025-05-05T00:00:00Z";

  const contaminatedDataset = structuredClone(dataset);
  const contaminatedDocument = contaminatedDataset.documents.find(
    (document) => document.id === "doc-time",
  );
  if (contaminatedDocument) contaminatedDocument.eventGroupId = "bridge-opening";

  const checks = [
    {
      id: "deliberately-wrong-verdict",
      detected: detectWrongVerdicts(dataset, wrongVerdict).includes("claim-time"),
    },
    {
      id: "invalid-citation",
      detected: detectInvalidCitations(dataset, invalidCitation).includes("invented-excerpt"),
    },
    {
      id: "temporal-leakage",
      detected: validateSplitLeakage(futureDataset).some(
        (issue) => issue.code === "temporal_leakage",
      ),
    },
    {
      id: "split-contamination",
      detected: validateSplitLeakage(contaminatedDataset).some(
        (issue) => issue.code === "event_split_leakage",
      ),
    },
  ];
  return { cleanRun, checks, passed: checks.every((check) => check.detected) };
}

export function detectWrongVerdicts(dataset: EvaluationDataset, run: AdapterRun) {
  const expected = new Map(
    dataset.claims.filter((claim) => claim.label).map((claim) => [claim.id, claim.label]),
  );
  return run.predictions
    .filter((prediction) => expected.get(prediction.claimId) !== prediction.label)
    .map((prediction) => prediction.claimId);
}

export function detectInvalidCitations(dataset: EvaluationDataset, run: AdapterRun) {
  const excerpts = new Set(dataset.excerpts.map((excerpt) => excerpt.id));
  return run.predictions.flatMap((prediction) =>
    prediction.citedExcerptIds.filter((excerptId) => !excerpts.has(excerptId)),
  );
}

function syntheticRun(dataset: EvaluationDataset, seed: number): AdapterRun {
  return {
    adapterId: "synthetic-fixture",
    adapterVersion: "1.0.0",
    mode: "fixture",
    datasetId: dataset.datasetId,
    datasetHash: datasetHash(dataset),
    seed,
    predictions: dataset.claims.flatMap((claim) =>
      claim.label
        ? [
            {
              claimId: claim.id,
              documentId: claim.documentId,
              predictedText: claim.text,
              predictedSpan: claim.spans[0] ?? null,
              label: claim.label,
              confidence: null,
              citedExcerptIds: claim.evidenceExcerptIds,
              evidenceSufficient: claim.evidenceExcerptIds.length > 0,
              evidenceApplicable: claim.evidenceExcerptIds.length > 0,
              citationEntailmentCorrect: null,
              originCandidateCorrect: claim.origin === "known_root" ? true : null,
              emittedGlobalOriginClaim: false,
              latencyMs: 0,
              costUsd: 0,
            },
          ]
        : [],
    ),
    extractionMatches: dataset.claims.map((claim) => ({
      documentId: claim.documentId,
      goldClaimId: claim.id,
      predictedClaimId: claim.id,
      status: "matched",
      method: "exact_span",
      rationale: "Synthetic invariant fixture uses an exact span identity.",
    })),
    outages: [],
  };
}

function selectSplit(dataset: EvaluationDataset, split: EvaluationSplit | "all") {
  if (split === "all") return dataset;
  const documents = dataset.documents.filter((document) => document.splitId === split);
  const documentIds = new Set(documents.map((document) => document.id));
  const claims = dataset.claims.filter((claim) => documentIds.has(claim.documentId));
  const excerptIds = new Set(claims.flatMap((claim) => claim.evidenceExcerptIds));
  const excerpts = dataset.excerpts.filter((excerpt) => excerptIds.has(excerpt.id));
  const evidenceIds = new Set(excerpts.map((excerpt) => excerpt.evidenceDocumentId));
  return {
    ...dataset,
    documents,
    claims,
    excerpts,
    evidenceDocuments: dataset.evidenceDocuments.filter((document) => evidenceIds.has(document.id)),
  };
}
