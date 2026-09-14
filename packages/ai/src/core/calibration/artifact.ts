import { createHash } from "node:crypto";
import {
  contentHashSchema,
  decisiveLabels,
  instantSchema,
  probabilitySchema,
  type ClaimLabel,
  type RunContext,
} from "@repo/contracts/core-v2";
import { z } from "zod";
import {
  ADJUDICATION_PROMPT_VERSION,
  CHALLENGE_PROMPT_VERSION,
} from "../adjudication/generation.js";
import { EVIDENCE_ASSESSMENT_PROMPT_VERSION } from "../evidence/index.js";
import {
  CALIBRATION_FEATURE_NAMES,
  CALIBRATION_FEATURE_VERSION,
  featureVector,
  type CalibrationFeatures,
} from "./features.js";
import { predictLogistic } from "./logistic.js";

export const CALIBRATOR_ARTIFACT_VERSION = "core-v2-calibrator-artifact-1.0.0";

const countSchema = z.number().int().nonnegative();

export const calibrationCompatibilitySchema = z.strictObject({
  engine: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  retriever: z.string().min(1),
});

export const calibratorArtifactSchema = z
  .strictObject({
    artifactVersion: z.literal(CALIBRATOR_ARTIFACT_VERSION),
    calibratorVersion: z.string().min(1),
    goldKind: z.enum(["adjudicated_human", "synthetic_fixture"]),
    compatibility: calibrationCompatibilitySchema.extend({
      featureVersion: z.string().min(1),
      evidencePromptVersion: z.string().min(1),
      adjudicationPromptVersion: z.string().min(1),
      challengePromptVersion: z.string().min(1),
    }),
    model: z.strictObject({
      kind: z.literal("l2_logistic_regression"),
      l2: z.number().positive().finite(),
      featureNames: z.array(z.string().min(1)),
      intercept: z.number().finite(),
      weights: z.array(z.number().finite()),
      means: z.array(z.number().finite()),
      scales: z.array(z.number().positive().finite()),
    }),
    precisionTarget: probabilitySchema,
    slices: z
      .array(
        z.strictObject({
          sliceId: z.string().min(1),
          language: z.string().min(2),
          label: z.enum(decisiveLabels),
          observations: countSchema,
          correct: countSchema,
          threshold: probabilitySchema.nullable(),
          thresholdPrecisionLowerBound: probabilitySchema.nullable(),
          thresholdCoverage: probabilitySchema.nullable(),
        }),
      )
      .min(1),
    dataset: z.strictObject({
      datasetId: z.string().min(1),
      datasetVersion: z.string().min(1),
      datasetHash: contentHashSchema,
      observationSetHash: contentHashSchema,
      split: z.literal("calibration"),
      goldObservations: countSchema,
      excludedObservations: countSchema,
    }),
    fit: z.strictObject({
      seed: countSchema,
      folds: z.number().int().min(2),
      outOfFold: z.literal(true),
      groupedBy: z.literal("eventGroupId"),
      fittedAt: instantSchema,
      validUntil: instantSchema,
    }),
    outOfFold: z.strictObject({
      count: countSchema,
      ece: z.number().nonnegative().finite().nullable(),
      brier: z.number().nonnegative().finite().nullable(),
    }),
    artifactHash: contentHashSchema,
  })
  .superRefine((artifact, context) => {
    const width = CALIBRATION_FEATURE_NAMES.length;
    if (
      artifact.model.featureNames.join("\0") !== CALIBRATION_FEATURE_NAMES.join("\0") ||
      artifact.model.weights.length !== width ||
      artifact.model.means.length !== width ||
      artifact.model.scales.length !== width
    )
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "Model parameters do not match the feature schema.",
      });
    if (new Set(artifact.slices.map(({ sliceId }) => sliceId)).size !== artifact.slices.length)
      context.addIssue({ code: "custom", path: ["slices"], message: "Slice IDs must be unique." });
    if (Date.parse(artifact.fit.validUntil) <= Date.parse(artifact.fit.fittedAt))
      context.addIssue({
        code: "custom",
        path: ["fit", "validUntil"],
        message: "Validity must end after fitting.",
      });
  });

export type CalibratorArtifact = z.infer<typeof calibratorArtifactSchema>;

export type ArtifactCheck =
  | { status: "valid"; artifact: CalibratorArtifact }
  | { status: "unavailable" | "invalidated"; calibratorVersion: string | null; reason: string };

export function currentComponentVersions() {
  return {
    featureVersion: CALIBRATION_FEATURE_VERSION,
    evidencePromptVersion: EVIDENCE_ASSESSMENT_PROMPT_VERSION,
    adjudicationPromptVersion: ADJUDICATION_PROMPT_VERSION,
    challengePromptVersion: CHALLENGE_PROMPT_VERSION,
  };
}

export function hashArtifactContent(artifact: Omit<CalibratorArtifact, "artifactHash">) {
  return `sha256:${createHash("sha256").update(canonicalJson(artifact)).digest("hex")}`;
}

/** Schema and content-hash integrity only; run compatibility is checked separately. */
export function verifyArtifactIntegrity(raw: unknown): ArtifactCheck {
  const parsed = calibratorArtifactSchema.safeParse(raw);
  if (!parsed.success)
    return {
      status: "invalidated",
      calibratorVersion: null,
      reason: "The calibration artifact failed schema validation.",
    };
  const { artifactHash, ...content } = parsed.data;
  if (hashArtifactContent(content) !== artifactHash)
    return {
      status: "invalidated",
      calibratorVersion: parsed.data.calibratorVersion,
      reason: "The calibration artifact hash does not match its content.",
    };
  return { status: "valid", artifact: parsed.data };
}

/** Missing, tampered, stale, expired or incompatible artifacts never yield a probability. */
export function checkCalibratorArtifact(
  raw: unknown,
  context: RunContext,
  now: string,
): ArtifactCheck {
  if (raw === null || raw === undefined)
    return {
      status: "unavailable",
      calibratorVersion: null,
      reason: "No correctness calibration artifact is installed.",
    };
  const integrity = verifyArtifactIntegrity(raw);
  if (integrity.status !== "valid") return integrity;
  const { artifact } = integrity;
  const invalid = (reason: string): ArtifactCheck => ({
    status: "invalidated",
    calibratorVersion: artifact.calibratorVersion,
    reason,
  });
  if (context.versions.calibration !== artifact.calibratorVersion)
    return invalid(
      `The run pins calibrator ${context.versions.calibration ?? "none"}, not ${artifact.calibratorVersion}.`,
    );
  for (const key of ["engine", "prompt", "model", "retriever"] as const) {
    if (artifact.compatibility[key] !== context.versions[key])
      return invalid(
        `The calibrator is stale: it was fitted for ${key} ${artifact.compatibility[key]}, not ${context.versions[key]}.`,
      );
  }
  const components = currentComponentVersions();
  for (const key of Object.keys(components) as Array<keyof typeof components>) {
    if (artifact.compatibility[key] !== components[key])
      return invalid(
        `The calibrator is stale: ${key} changed from ${artifact.compatibility[key]} to ${components[key]}.`,
      );
  }
  const at = Date.parse(now);
  if (at > Date.parse(artifact.fit.validUntil))
    return invalid(`The calibrator expired at ${artifact.fit.validUntil}.`);
  if (at < Date.parse(artifact.fit.fittedAt))
    return invalid("The calibrator was fitted after the run clock reading.");
  if (artifact.goldKind !== "adjudicated_human" && context.executionMode !== "fixture")
    return invalid("A synthetic fixture calibrator may only run in fixture execution mode.");
  return integrity;
}

export function findSlice(
  artifact: CalibratorArtifact,
  language: string | null,
  label: ClaimLabel,
) {
  if (language === null) return undefined;
  return artifact.slices.find((slice) => slice.language === language && slice.label === label);
}

export function predictCorrectness(artifact: CalibratorArtifact, features: CalibrationFeatures) {
  return predictLogistic(artifact.model, featureVector(features));
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
