import type { AdapterRun, EvaluationDataset, EvaluationPrediction, TruthLabel } from "./schemas.js";

const labels: TruthLabel[] = ["supported", "contradicted", "misleading", "mixed", "unverified"];
const oneSidedZ = 1.6448536269514722;

export type GateStatus = "pass" | "fail" | "not_evaluated";

export interface MetricResult {
  status: GateStatus;
  numerator: number | null;
  denominator: number;
  value: number | null;
  lowerBound?: number | null;
  target: string;
  omissions: number;
  notes: string[];
}

export interface EvaluationMetrics {
  claimExtraction: {
    recall: MetricResult;
    semanticPrecision: MetricResult;
    atomicity: MetricResult;
    unresolvedMatches: number;
  };
  citationIntegrity: MetricResult;
  evidenceValidity: MetricResult;
  retrieval: MetricResult;
  decisiveVerdicts: {
    supportedPrecision: MetricResult;
    contradictedPrecision: MetricResult;
  };
  coverage: MetricResult;
  otherVerdicts: {
    macroF1: MetricResult;
    confusionMatrix: Record<TruthLabel, Record<TruthLabel, number>>;
    perLabel: Record<TruthLabel, { precision: MetricResult; recall: MetricResult }>;
  };
  calibration: {
    ece: MetricResult;
    brier: MetricResult;
    bins: Array<{
      lower: number;
      upper: number;
      count: number;
      accuracy: number | null;
      confidence: number | null;
    }>;
    riskCoverage: Array<{ coverage: number; risk: number }>;
  };
  origin: { precision: MetricResult; coverage: MetricResult; globalOverclaims: number };
  improvement: MetricResult & { bootstrapSamples: number; seed: number };
}

export function computeMetrics(
  dataset: EvaluationDataset,
  run: AdapterRun,
  baseline: AdapterRun | undefined,
  seed: number,
): EvaluationMetrics {
  const goldClaims = dataset.claims.filter((claim) => claim.goldStatus === "adjudicated_human");
  const goldById = new Map(goldClaims.map((claim) => [claim.id, claim]));
  const predictions = run.predictions.filter((prediction) => goldById.has(prediction.claimId));
  const predictionsById = new Map(
    predictions.map((prediction) => [prediction.claimId, prediction]),
  );
  const matches = run.extractionMatches.filter(
    (match) => match.goldClaimId !== null && goldById.has(match.goldClaimId),
  );
  const goldDocumentIds = new Set(goldClaims.map((claim) => claim.documentId));
  const evaluatedExtractionMatches = run.extractionMatches.filter((match) =>
    goldDocumentIds.has(match.documentId),
  );
  const materialClaims = goldClaims.filter(
    (claim) => claim.material && claim.checkability !== "non_factual",
  );
  const matchedGold = matches.filter((match) => match.status === "matched").length;
  const validCitations = predictions.flatMap((prediction) =>
    prediction.citedExcerptIds.map((excerptId) => ({ prediction, excerptId })),
  );
  const excerptIds = new Set(dataset.excerpts.map((excerpt) => excerpt.id));
  const citationPasses = validCitations.filter(({ excerptId }) => excerptIds.has(excerptId)).length;
  const answerable = materialClaims.filter((claim) => claim.checkability === "checkable");
  const sufficient = answerable.filter(
    (claim) => predictionsById.get(claim.id)?.evidenceSufficient === true,
  ).length;

  const perLabel = Object.fromEntries(
    labels.map((label) => {
      const predicted = predictions.filter((prediction) => prediction.label === label);
      const actual = goldClaims.filter((claim) => claim.label === label);
      const truePositive = predicted.filter(
        (prediction) => goldById.get(prediction.claimId)?.label === label,
      ).length;
      return [
        label,
        {
          precision: proportion(truePositive, predicted.length, ">= 0.95 for decisive labels"),
          recall: proportion(truePositive, actual.length, "reported per label"),
        },
      ];
    }),
  ) as EvaluationMetrics["otherVerdicts"]["perLabel"];
  perLabel.supported.precision = wilsonGate(perLabel.supported.precision, 0.95);
  perLabel.contradicted.precision = wilsonGate(perLabel.contradicted.precision, 0.95);

  const f1Values = labels
    .map((label) => f1(perLabel[label].precision.value, perLabel[label].recall.value))
    .filter((value): value is number => value !== null);
  const confidencePredictions = predictions.filter(
    (prediction): prediction is EvaluationPrediction & { confidence: number } =>
      prediction.confidence !== null,
  );
  const calibration = calibrationMetrics(confidencePredictions, goldById);
  const originKnown = goldClaims.filter((claim) => claim.origin === "known_root");
  const originPredictions = originKnown
    .map((claim) => predictionsById.get(claim.id))
    .filter((prediction): prediction is EvaluationPrediction => prediction !== undefined);
  const originCorrect = originPredictions.filter(
    (prediction) => prediction.originCandidateCorrect === true,
  ).length;
  const baselineById = new Map(
    baseline?.predictions.map((prediction) => [prediction.claimId, prediction]) ?? [],
  );
  const paired = goldClaims.flatMap((claim) => {
    const current = predictionsById.get(claim.id);
    const previous = baselineById.get(claim.id);
    const document = dataset.documents.find((item) => item.id === claim.documentId);
    if (!current || !previous || !document || !claim.label) return [];
    return [
      {
        cluster: document.eventGroupId,
        delta:
          Number(jointSuccess(current, claim.label)) - Number(jointSuccess(previous, claim.label)),
      },
    ];
  });
  const improvement = clusteredBootstrap(paired, seed, 10_000);

  return {
    claimExtraction: {
      recall: threshold(matchedGold, materialClaims.length, 0.95, matches.length - matchedGold),
      semanticPrecision: threshold(
        matches.filter((match) => match.status === "matched").length,
        evaluatedExtractionMatches.filter((match) => match.predictedClaimId !== null).length,
        0.98,
        evaluatedExtractionMatches.filter((match) => match.status === "unresolved").length,
      ),
      atomicity: reportOnly(
        predictions.filter((prediction) => isAtomic(prediction.predictedText)).length,
        predictions.length,
      ),
      unresolvedMatches: matches.filter((match) => match.status === "unresolved").length,
    },
    citationIntegrity: threshold(citationPasses, validCitations.length, 1),
    evidenceValidity: threshold(
      predictions.filter((prediction) => prediction.citationEntailmentCorrect === true).length,
      predictions.filter((prediction) => prediction.citationEntailmentCorrect !== null).length,
      0.98,
    ),
    retrieval: threshold(sufficient, answerable.length, 0.9),
    decisiveVerdicts: {
      supportedPrecision: perLabel.supported.precision,
      contradictedPrecision: perLabel.contradicted.precision,
    },
    coverage: threshold(
      answerable.filter((claim) => {
        const prediction = predictionsById.get(claim.id);
        return Boolean(
          prediction &&
          (prediction.label === "supported" || prediction.label === "contradicted") &&
          prediction.label === claim.label,
        );
      }).length,
      answerable.length,
      0.7,
    ),
    otherVerdicts: {
      macroF1:
        f1Values.length === labels.length
          ? thresholdValue(f1Values.reduce((sum, value) => sum + value, 0) / labels.length, 0.85)
          : notEvaluated("All five labels require nonzero gold and prediction denominators."),
      confusionMatrix: confusionMatrix(predictions, goldById),
      perLabel,
    },
    calibration: {
      ece: calibration.ece,
      brier: calibration.brier,
      bins: calibration.bins,
      riskCoverage: calibration.riskCoverage,
    },
    origin: {
      precision: threshold(originCorrect, originPredictions.length, 0.95),
      coverage: threshold(originPredictions.length, originKnown.length, 0.7),
      globalOverclaims: predictions.filter((prediction) => prediction.emittedGlobalOriginClaim)
        .length,
    },
    improvement: {
      status:
        improvement.lowerBound === null
          ? "not_evaluated"
          : improvement.lowerBound > 0
            ? "pass"
            : "fail",
      numerator: paired.reduce((sum, item) => sum + item.delta, 0),
      denominator: paired.length,
      value: improvement.mean,
      lowerBound: improvement.lowerBound,
      target: "paired story-cluster bootstrap 95% lower bound > 0",
      omissions: goldClaims.length - paired.length,
      notes:
        improvement.lowerBound === null ? ["Matched v1/v2 human-gold pairs are required."] : [],
      bootstrapSamples: 10_000,
      seed,
    },
  };
}

export function wilsonLowerBound(successes: number, total: number, z = oneSidedZ) {
  if (total === 0) return null;
  const probability = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = probability + (z * z) / (2 * total);
  const margin = z * Math.sqrt((probability * (1 - probability) + (z * z) / (4 * total)) / total);
  return (center - margin) / denominator;
}

export function clusteredBootstrap(
  values: Array<{ cluster: string; delta: number }>,
  seed: number,
  samples: number,
) {
  if (values.length === 0) return { mean: null, lowerBound: null };
  const clusters = new Map<string, number[]>();
  for (const value of values)
    clusters.set(value.cluster, [...(clusters.get(value.cluster) ?? []), value.delta]);
  const groups = [...clusters.values()];
  if (groups.length < 2)
    return { mean: mean(values.map((value) => value.delta)), lowerBound: null };
  const random = mulberry32(seed);
  const estimates = Array.from({ length: samples }, () => {
    const sampled = Array.from(
      { length: groups.length },
      () => groups[Math.floor(random() * groups.length)] ?? [],
    );
    return mean(sampled.flat());
  }).sort((left, right) => left - right);
  return {
    mean: mean(values.map((value) => value.delta)),
    lowerBound: estimates[Math.floor(samples * 0.05)] ?? null,
  };
}

function calibrationMetrics(
  predictions: Array<EvaluationPrediction & { confidence: number }>,
  goldById: Map<string, EvaluationDataset["claims"][number]>,
) {
  if (predictions.length === 0) {
    return {
      ece: notEvaluated("Calibrated confidence and human gold are required."),
      brier: notEvaluated("Calibrated confidence and human gold are required."),
      bins: Array.from({ length: 10 }, (_, index) => ({
        lower: index / 10,
        upper: (index + 1) / 10,
        count: 0,
        accuracy: null,
        confidence: null,
      })),
      riskCoverage: [],
    };
  }
  const bins = Array.from({ length: 10 }, (_, index) => {
    const lower = index / 10;
    const upper = (index + 1) / 10;
    const members = predictions.filter(
      ({ confidence }) =>
        confidence >= lower && (index === 9 ? confidence <= upper : confidence < upper),
    );
    return {
      lower,
      upper,
      count: members.length,
      accuracy: members.length
        ? mean(
            members.map((prediction) =>
              Number(goldById.get(prediction.claimId)?.label === prediction.label),
            ),
          )
        : null,
      confidence: members.length ? mean(members.map((prediction) => prediction.confidence)) : null,
    };
  });
  const ece = bins.reduce(
    (sum, bin) =>
      sum +
      (bin.count / predictions.length) * Math.abs((bin.accuracy ?? 0) - (bin.confidence ?? 0)),
    0,
  );
  const brier = mean(
    predictions.map(
      (prediction) =>
        (prediction.confidence -
          Number(goldById.get(prediction.claimId)?.label === prediction.label)) **
        2,
    ),
  );
  const ordered = [...predictions].sort((left, right) => right.confidence - left.confidence);
  const riskCoverage = ordered.map((_, index) => {
    const selected = ordered.slice(0, index + 1);
    return {
      coverage: (index + 1) / ordered.length,
      risk:
        1 -
        mean(
          selected.map((prediction) =>
            Number(goldById.get(prediction.claimId)?.label === prediction.label),
          ),
        ),
    };
  });
  return { ece: inverseThresholdValue(ece, 0.05), brier: reportValue(brier), bins, riskCoverage };
}

function confusionMatrix(
  predictions: EvaluationPrediction[],
  goldById: Map<string, EvaluationDataset["claims"][number]>,
) {
  const matrix = Object.fromEntries(
    labels.map((actual) => [actual, Object.fromEntries(labels.map((predicted) => [predicted, 0]))]),
  ) as Record<TruthLabel, Record<TruthLabel, number>>;
  for (const prediction of predictions) {
    const actual = goldById.get(prediction.claimId)?.label;
    if (actual) matrix[actual][prediction.label] += 1;
  }
  return matrix;
}

function jointSuccess(prediction: EvaluationPrediction, label: TruthLabel) {
  return (
    prediction.label === label &&
    prediction.evidenceSufficient &&
    prediction.evidenceApplicable &&
    prediction.citedExcerptIds.length > 0
  );
}

function threshold(
  numerator: number,
  denominator: number,
  target: number,
  omissions = 0,
): MetricResult {
  if (denominator === 0) return notEvaluated("A nonzero denominator is required.", `>= ${target}`);
  const value = numerator / denominator;
  return {
    status: value >= target ? "pass" : "fail",
    numerator,
    denominator,
    value,
    target: `>= ${target}`,
    omissions,
    notes: [],
  };
}

function reportOnly(numerator: number, denominator: number): MetricResult {
  if (denominator === 0) return notEvaluated("A nonzero denominator is required.", "report only");
  return {
    status: "not_evaluated",
    numerator,
    denominator,
    value: numerator / denominator,
    target: "report only",
    omissions: 0,
    notes: ["No release threshold is defined."],
  };
}

function wilsonGate(metric: MetricResult, target: number): MetricResult {
  const lowerBound =
    metric.numerator === null ? null : wilsonLowerBound(metric.numerator, metric.denominator);
  return {
    ...metric,
    lowerBound,
    status: lowerBound === null ? "not_evaluated" : lowerBound >= target ? "pass" : "fail",
    target: `one-sided 95% Wilson lower bound >= ${target}`,
  };
}

function thresholdValue(value: number, target: number): MetricResult {
  return {
    status: value >= target ? "pass" : "fail",
    numerator: null,
    denominator: 1,
    value,
    target: `>= ${target}`,
    omissions: 0,
    notes: [],
  };
}

function inverseThresholdValue(value: number, target: number): MetricResult {
  return {
    status: value <= target ? "pass" : "fail",
    numerator: null,
    denominator: 1,
    value,
    target: `<= ${target}`,
    omissions: 0,
    notes: [],
  };
}

function reportValue(value: number): MetricResult {
  return {
    status: "not_evaluated",
    numerator: null,
    denominator: 1,
    value,
    target: "report only",
    omissions: 0,
    notes: ["No release threshold is defined."],
  };
}

function notEvaluated(note: string, target = "not evaluated"): MetricResult {
  return {
    status: "not_evaluated",
    numerator: null,
    denominator: 0,
    value: null,
    target,
    omissions: 0,
    notes: [note],
  };
}

function isAtomic(text: string) {
  return (
    text.length <= 240 &&
    !text.includes(";") &&
    (text.match(/\b(and|but|while|whereas)\b/giu)?.length ?? 0) <= 1
  );
}

function f1(precision: number | null, recall: number | null) {
  if (precision === null || recall === null || precision + recall === 0) return null;
  return (2 * precision * recall) / (precision + recall);
}

function proportion(numerator: number, denominator: number, target: string): MetricResult {
  if (denominator === 0) return notEvaluated("A nonzero denominator is required.", target);
  return {
    status: "not_evaluated",
    numerator,
    denominator,
    value: numerator / denominator,
    target,
    omissions: 0,
    notes: [],
  };
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
