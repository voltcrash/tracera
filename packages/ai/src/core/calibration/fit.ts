import { createHash } from "node:crypto";
import { claimLabelSchema, contentHashSchema, type ClaimLabel } from "@repo/contracts/core-v2";
import { z } from "zod";
import { evaluateRun } from "../../../evaluation/harness.js";
import { wilsonLowerBound } from "../../../evaluation/metrics.js";
import {
  datasetHash,
  evaluationDatasetSchema,
  type AdapterRun,
  type EvaluationDataset,
  type EvaluationSplit,
} from "../../../evaluation/schemas.js";
import { validateSplitLeakage } from "../../../evaluation/validation.js";
import { isDecisive, type DecisiveLabel } from "../adjudication/policy.js";
import {
  CALIBRATOR_ARTIFACT_VERSION,
  calibrationCompatibilitySchema,
  canonicalJson,
  currentComponentVersions,
  findSlice,
  hashArtifactContent,
  predictCorrectness,
  verifyArtifactIntegrity,
  type CalibratorArtifact,
} from "./artifact.js";
import { CALIBRATION_FEATURE_NAMES, calibrationFeaturesSchema, featureVector } from "./features.js";
import { fitLogistic, predictLogistic } from "./logistic.js";

export const CALIBRATION_OBSERVATION_SET_VERSION = "core-v2-calibration-observations-1.0.0";

export const calibrationObservationSetSchema = z.strictObject({
  observationSetVersion: z.literal(CALIBRATION_OBSERVATION_SET_VERSION),
  datasetId: z.string().min(1),
  datasetHash: contentHashSchema,
  versions: calibrationCompatibilitySchema,
  observations: z.array(
    z.strictObject({
      datasetClaimId: z.string().min(1),
      diagnosticLabel: claimLabelSchema,
      language: z.string().min(2),
      features: calibrationFeaturesSchema,
    }),
  ),
});

export type CalibrationObservationSet = z.infer<typeof calibrationObservationSetSchema>;

export interface CalibrationFitPolicy {
  minGoldObservations: number;
  minSliceObservations: number;
  folds: number;
  l2: number;
  precisionTarget: number;
  validForDays: number;
  /** Only fixture verification may fit synthetic labels; such artifacts never leave fixture mode. */
  allowSyntheticLabels: boolean;
}

/**
 * PLAN.md minimums: 500 calibration claims, 50 per advertised slice, 0.95 decisive precision.
 * Fold count, L2 strength and the validity window are provisional engineering defaults.
 */
export const RELEASE_CALIBRATION_POLICY: CalibrationFitPolicy = {
  minGoldObservations: 500,
  minSliceObservations: 50,
  folds: 5,
  l2: 1,
  precisionTarget: 0.95,
  validForDays: 180,
  allowSyntheticLabels: false,
};

export interface CalibrationCounts {
  observations: number;
  decisiveObservations: number;
  goldObservations: number;
  excludedObservations: number;
  eventGroups: number;
}

export type CalibrationFitResult =
  | { status: "refused"; reasons: string[] }
  | { status: "blocked"; reasons: string[]; counts: CalibrationCounts }
  | { status: "fitted"; artifact: CalibratorArtifact; counts: CalibrationCounts };

export function fitCorrectnessCalibrator(input: {
  dataset: unknown;
  observations: unknown;
  policy: CalibrationFitPolicy;
  seed: number;
  fittedAt: string;
}): CalibrationFitResult {
  const prepared = prepare(input.dataset, input.observations);
  if (prepared.status === "refused") return prepared;
  const { dataset, observationSet, rows: allRows } = prepared;
  const wrongSplit = allRows.filter(({ split }) => split !== "calibration");
  if (wrongSplit.length > 0)
    return {
      status: "refused",
      reasons: wrongSplit.map(
        ({ claimId, split }) =>
          `Observation ${claimId} belongs to the ${split} partition; fitting reads only the calibration partition.`,
      ),
    };

  const decisive = allRows.filter((row) => isDecisive(row.label));
  const gold = decisive.filter(
    (row) =>
      row.goldStatus === "adjudicated_human" ||
      (input.policy.allowSyntheticLabels && row.goldStatus === "synthetic"),
  );
  const groups = [...new Set(gold.map(({ eventGroupId }) => eventGroupId))];
  const counts: CalibrationCounts = {
    observations: allRows.length,
    decisiveObservations: decisive.length,
    goldObservations: gold.length,
    excludedObservations: allRows.length - gold.length,
    eventGroups: groups.length,
  };
  const reasons: string[] = [];
  if (gold.length < input.policy.minGoldObservations)
    reasons.push(
      `Calibration needs at least ${input.policy.minGoldObservations} independently adjudicated decisive observations; ${gold.length} are available.`,
    );
  if (groups.length < input.policy.folds)
    reasons.push(
      `Grouped out-of-fold fitting needs at least ${input.policy.folds} event groups; ${groups.length} are available.`,
    );
  if (reasons.length > 0) return { status: "blocked", reasons, counts };

  const foldOf = assignFolds(groups, input.policy.folds, input.seed);
  const outOfFold = new Map<string, number>();
  for (let fold = 0; fold < input.policy.folds; fold += 1) {
    const training = gold.filter(({ eventGroupId }) => foldOf.get(eventGroupId) !== fold);
    const held = gold.filter(({ eventGroupId }) => foldOf.get(eventGroupId) === fold);
    const model = fitLogistic(
      training.map(({ vector }) => vector),
      training.map(({ correct }) => Number(correct)),
      input.policy.l2,
    );
    for (const row of held) outOfFold.set(row.claimId, predictLogistic(model, row.vector));
  }

  const slices: CalibratorArtifact["slices"] = [];
  const bySlice = new Map<string, typeof gold>();
  for (const row of gold) {
    const key = `${row.language}/${row.label}`;
    bySlice.set(key, [...(bySlice.get(key) ?? []), row]);
  }
  for (const [sliceId, members] of [...bySlice.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (members.length < input.policy.minSliceObservations) continue;
    const scored = members.map((row) => ({
      probability: outOfFold.get(row.claimId)!,
      correct: row.correct,
    }));
    const selected = selectThreshold(scored, input.policy.precisionTarget);
    slices.push({
      sliceId,
      language: members[0]!.language,
      label: members[0]!.label as DecisiveLabel,
      observations: members.length,
      correct: members.filter(({ correct }) => correct).length,
      ...selected,
    });
  }
  if (slices.length === 0)
    return {
      status: "blocked",
      reasons: [
        `No language/label slice reached ${input.policy.minSliceObservations} adjudicated observations.`,
      ],
      counts,
    };

  const finalModel = fitLogistic(
    gold.map(({ vector }) => vector),
    gold.map(({ correct }) => Number(correct)),
    input.policy.l2,
  );
  const oofMetrics = harnessCalibration(
    dataset,
    "calibration",
    input.seed,
    gold.map((row) => ({ ...row, probability: outOfFold.get(row.claimId)! })),
  );
  const body: Omit<CalibratorArtifact, "artifactHash" | "calibratorVersion"> = {
    artifactVersion: CALIBRATOR_ARTIFACT_VERSION,
    goldKind: gold.every(({ goldStatus }) => goldStatus === "adjudicated_human")
      ? "adjudicated_human"
      : "synthetic_fixture",
    compatibility: { ...observationSet.versions, ...currentComponentVersions() },
    model: {
      kind: "l2_logistic_regression",
      l2: input.policy.l2,
      featureNames: [...CALIBRATION_FEATURE_NAMES],
      ...finalModel,
    },
    precisionTarget: input.policy.precisionTarget,
    slices,
    dataset: {
      datasetId: dataset.datasetId,
      datasetVersion: dataset.datasetVersion,
      datasetHash: datasetHash(dataset),
      observationSetHash: `sha256:${createHash("sha256").update(canonicalJson(observationSet)).digest("hex")}`,
      split: "calibration",
      goldObservations: gold.length,
      excludedObservations: counts.excludedObservations,
    },
    fit: {
      seed: input.seed,
      folds: input.policy.folds,
      outOfFold: true,
      groupedBy: "eventGroupId",
      fittedAt: input.fittedAt,
      validUntil: new Date(
        Date.parse(input.fittedAt) + input.policy.validForDays * 86_400_000,
      ).toISOString(),
    },
    outOfFold: { count: outOfFold.size, ece: oofMetrics.ece, brier: oofMetrics.brier },
  };
  const calibratorVersion = `core-v2-calibrator-${createHash("sha256").update(canonicalJson(body)).digest("hex").slice(0, 16)}`;
  const content = { ...body, calibratorVersion };
  return {
    status: "fitted",
    artifact: { ...content, artifactHash: hashArtifactContent(content) },
    counts,
  };
}

export function evaluateCorrectnessCalibrator(input: {
  dataset: unknown;
  observations: unknown;
  artifact: unknown;
  split: Exclude<EvaluationSplit, "calibration">;
  seed: number;
  allowSealedTest: boolean;
}) {
  const integrity = verifyArtifactIntegrity(input.artifact);
  if (integrity.status !== "valid")
    return { status: "refused" as const, reasons: [integrity.reason] };
  if (input.split === "test" && !input.allowSealedTest)
    return {
      status: "refused" as const,
      reasons: ["The sealed test partition is opened only for the recorded release evaluation."],
    };
  const prepared = prepare(input.dataset, input.observations);
  if (prepared.status === "refused") return prepared;
  const { artifact } = integrity;
  const reasons: string[] = [];
  if (datasetHash(prepared.dataset) !== artifact.dataset.datasetHash)
    reasons.push(
      "The evaluation dataset hash differs from the dataset used to fit the calibrator.",
    );
  for (const key of ["engine", "prompt", "model", "retriever"] as const)
    if (prepared.observationSet.versions[key] !== artifact.compatibility[key])
      reasons.push(
        `Observations were produced by ${key} ${prepared.observationSet.versions[key]}, not ${artifact.compatibility[key]}.`,
      );
  for (const row of prepared.rows)
    if (row.split !== input.split)
      reasons.push(`Observation ${row.claimId} is not in the ${input.split} partition.`);
  if (reasons.length > 0) return { status: "refused" as const, reasons };

  const scored = prepared.rows.flatMap((row) => {
    const slice = isDecisive(row.label) ? findSlice(artifact, row.language, row.label) : undefined;
    if (slice === undefined) return [];
    const probability = predictCorrectness(artifact, calibrationFeaturesSchema.parse(row.features));
    return [
      {
        ...row,
        probability,
        published: slice.threshold !== null && probability >= slice.threshold,
      },
    ];
  });
  const gold = scored.filter(({ goldStatus }) => goldStatus === "adjudicated_human");
  const published = gold.filter((row) => row.published);
  const perLabel = Object.fromEntries(
    (["supported", "contradicted", "misleading"] as const).map((label) => {
      const members = published.filter((row) => row.label === label);
      const correct = members.filter((row) => row.correct).length;
      const lowerBound = wilsonLowerBound(correct, members.length);
      return [
        label,
        {
          numerator: members.length === 0 ? null : correct,
          denominator: members.length,
          lowerBound,
          status:
            lowerBound === null
              ? "not_evaluated"
              : lowerBound >= artifact.precisionTarget
                ? "pass"
                : "fail",
        },
      ];
    }),
  );
  return {
    status: "evaluated" as const,
    split: input.split,
    datasetHash: artifact.dataset.datasetHash,
    calibratorVersion: artifact.calibratorVersion,
    artifactHash: artifact.artifactHash,
    counts: {
      observations: prepared.rows.length,
      inScope: scored.length,
      goldInScope: gold.length,
      goldPublished: published.length,
    },
    publishedPrecision: perLabel,
    calibration: harnessCalibration(prepared.dataset, input.split, input.seed, scored),
  };
}

interface PreparedRow {
  claimId: string;
  label: ClaimLabel;
  language: string;
  features: unknown;
  vector: number[];
  split: EvaluationSplit;
  eventGroupId: string;
  goldStatus: EvaluationDataset["claims"][number]["goldStatus"];
  correct: boolean;
  documentId: string;
  text: string;
}

function prepare(
  rawDataset: unknown,
  rawObservations: unknown,
):
  | { status: "refused"; reasons: string[] }
  | {
      status: "prepared";
      dataset: EvaluationDataset;
      observationSet: CalibrationObservationSet;
      rows: PreparedRow[];
    } {
  const datasetResult = evaluationDatasetSchema.safeParse(rawDataset);
  const observationResult = calibrationObservationSetSchema.safeParse(rawObservations);
  if (!datasetResult.success || !observationResult.success)
    return {
      status: "refused",
      reasons: [
        ...(datasetResult.success ? [] : ["The dataset failed schema, hash or span validation."]),
        ...(observationResult.success ? [] : ["The observation set failed schema validation."]),
      ],
    };
  const dataset = datasetResult.data;
  const observationSet = observationResult.data;
  const reasons: string[] = [];
  if (
    observationSet.datasetId !== dataset.datasetId ||
    observationSet.datasetHash !== datasetHash(dataset)
  )
    reasons.push("Observations were produced for a different dataset identity or hash.");
  for (const leak of validateSplitLeakage(dataset))
    reasons.push(`Split leakage (${leak.code}): ${leak.message}`);
  const claims = new Map(dataset.claims.map((claim) => [claim.id, claim]));
  const documents = new Map(dataset.documents.map((document) => [document.id, document]));
  const seen = new Set<string>();
  const rows: PreparedRow[] = [];
  for (const observation of observationSet.observations) {
    const claim = claims.get(observation.datasetClaimId);
    const document = claim === undefined ? undefined : documents.get(claim.documentId);
    if (claim === undefined || document === undefined) {
      reasons.push(`Observation ${observation.datasetClaimId} does not reference a dataset claim.`);
      continue;
    }
    if (seen.has(claim.id)) reasons.push(`Observation ${claim.id} is duplicated.`);
    seen.add(claim.id);
    rows.push({
      claimId: claim.id,
      label: observation.diagnosticLabel,
      language: observation.language,
      features: observation.features,
      vector: featureVector(observation.features),
      split: document.splitId,
      eventGroupId: document.eventGroupId,
      goldStatus: claim.goldStatus,
      correct: claim.label === observation.diagnosticLabel,
      documentId: claim.documentId,
      text: claim.text,
    });
  }
  return reasons.length > 0
    ? { status: "refused", reasons }
    : { status: "prepared", dataset, observationSet, rows };
}

/** Largest-coverage threshold: the smallest cut whose Wilson lower precision bound meets the target. */
function selectThreshold(scored: Array<{ probability: number; correct: boolean }>, target: number) {
  const candidates = [...new Set(scored.map(({ probability }) => probability))].sort(
    (left, right) => left - right,
  );
  for (const threshold of candidates) {
    const selected = scored.filter(({ probability }) => probability >= threshold);
    const lowerBound = wilsonLowerBound(
      selected.filter(({ correct }) => correct).length,
      selected.length,
    );
    if (lowerBound !== null && lowerBound >= target)
      return {
        threshold,
        thresholdPrecisionLowerBound: lowerBound,
        thresholdCoverage: selected.length / scored.length,
      };
  }
  return { threshold: null, thresholdPrecisionLowerBound: null, thresholdCoverage: null };
}

function assignFolds(groups: string[], folds: number, seed: number) {
  const ordered = [...groups].sort((left, right) => {
    const a = createHash("sha256").update(`${seed}\0${left}`).digest("hex");
    const b = createHash("sha256").update(`${seed}\0${right}`).digest("hex");
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return new Map(ordered.map((group, index) => [group, index % folds]));
}

/** Reuses the Task 01 harness so ECE bins and Brier score match release reporting. */
function harnessCalibration(
  dataset: EvaluationDataset,
  split: EvaluationSplit,
  seed: number,
  rows: Array<PreparedRow & { probability: number }>,
) {
  const run: AdapterRun = {
    adapterId: "core-v2-correctness-calibrator",
    adapterVersion: CALIBRATOR_ARTIFACT_VERSION,
    mode: "replay",
    datasetId: dataset.datasetId,
    datasetHash: datasetHash(dataset),
    seed,
    predictions: rows.map((row) => ({
      claimId: row.claimId,
      documentId: row.documentId,
      predictedText: row.text,
      predictedSpan: null,
      label: row.label,
      confidence: row.probability,
      citedExcerptIds: [],
      evidenceSufficient: false,
      evidenceApplicable: false,
      citationEntailmentCorrect: null,
      originCandidateCorrect: null,
      emittedGlobalOriginClaim: false,
      latencyMs: 0,
      costUsd: null,
    })),
    extractionMatches: [],
    outages: [],
  };
  const { metrics } = evaluateRun(dataset, run, { split, seed });
  return {
    ece: metrics.calibration.ece.value,
    brier: metrics.calibration.brier.value,
    eceStatus: metrics.calibration.ece.status,
    bins: metrics.calibration.bins,
  };
}
