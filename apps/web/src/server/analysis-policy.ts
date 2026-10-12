import {
  resolveAnalysisProvider,
  type AiProviderConfig,
  type AnalysisProviderEnvironment,
} from "@repo/ai";
import { ANALYSIS_ENGINE_VERSION } from "@repo/ai/analysis";
import { hashValue } from "@repo/ai/analysis/hashing";
import type { RunInput } from "@repo/ai/analysis/types";
import {
  ANALYSIS_EVALUATION_BUDGET,
  runContextSchema,
  type RunBudget,
  type RunContext,
} from "@repo/contracts/analysis";
import type { ServerEnv } from "./env";

const ANALYSIS_PROMPT_VERSION = "tracera-prompts-1.0.0";
const ANALYSIS_RETRIEVER_VERSION = "tracera-retrieval-1.0.0";
const ANALYSIS_EMBEDDING_PREPROCESSING = "tracera-normalized-text-1.0.0";
const EMBEDDING_DIMENSIONS = 1024;

const TEST_FOCUSED_BUDGET: RunBudget = {
  ...ANALYSIS_EVALUATION_BUDGET,
  maxCostUsd: 1,
};

export type RuntimeEnvironment = { readonly [name: string]: unknown };

export interface AnalysisRuntimePolicy {
  mode: "fixture" | "live";
  providerConfig: AiProviderConfig | null;
  providerIdentity?: RunContext["provider"];
  versions: RunContext["versions"];
  budget: RunBudget;
}

export type AnalysisRuntimePolicyResult =
  | { enabled: true; policy: AnalysisRuntimePolicy }
  | { enabled: false; code: "analysis_unavailable"; message: string };

function livePolicy(environment: RuntimeEnvironment, userId: string): AnalysisRuntimePolicyResult {
  let resolved: ReturnType<typeof resolveAnalysisProvider>;
  try {
    resolved = resolveAnalysisProvider({ userId, env: environment as AnalysisProviderEnvironment });
  } catch (error) {
    return unavailable(
      error instanceof Error ? error.message : "AI provider configuration is unavailable.",
    );
  }
  const providerConfig = resolved.config;
  const model = providerConfig.model;
  const embeddingModel = providerConfig.embedding?.model ?? providerConfig.embeddingModel!;

  const budget = readLiveBudget(environment);
  if (!budget.ok) return unavailable(budget.message);
  const spend = readLiveSpend(environment);
  if (!spend.ok) return unavailable(spend.message);

  return {
    enabled: true,
    policy: {
      mode: "live",
      providerConfig,
      providerIdentity: { source: resolved.source, provider: providerConfig.provider },
      versions: {
        engine: ANALYSIS_ENGINE_VERSION,
        prompt: ANALYSIS_PROMPT_VERSION,
        model,
        retriever: ANALYSIS_RETRIEVER_VERSION,
        embedding: {
          model: embeddingModel,
          dimensions: EMBEDDING_DIMENSIONS,
          preprocessing: ANALYSIS_EMBEDDING_PREPROCESSING,
        },
        calibration: null,
      },
      budget: budget.value,
    },
  };
}

/** Fixture analysis runs the scripted ports offline and only in local development (D9). */
export function analysisPolicy(
  env: Pick<ServerEnv, "MODE" | "ANALYSIS_MODE"> & RuntimeEnvironment,
  userId: string,
): AnalysisRuntimePolicyResult {
  if (env.ANALYSIS_MODE === "fixture") {
    if (env.MODE !== "dev") return unavailable("Fixture analysis runs only in local development.");
    return {
      enabled: true,
      policy: {
        mode: "fixture",
        providerConfig: null,
        versions: testVersions(),
        budget: TEST_FOCUSED_BUDGET,
      },
    };
  }
  return livePolicy(env, userId);
}

function readLiveBudget(environment: RuntimeEnvironment) {
  const values = {
    maxExternalRequests: readPositiveInteger(environment, "ANALYSIS_MAX_EXTERNAL_REQUESTS"),
    maxDiscoveryQueriesPerClaim: readPositiveInteger(
      environment,
      "ANALYSIS_MAX_DISCOVERY_QUERIES_PER_CLAIM",
    ),
    maxFetchedCandidatesPerClaim: readPositiveInteger(
      environment,
      "ANALYSIS_MAX_FETCHED_CANDIDATES_PER_CLAIM",
    ),
    maxProvenanceHops: readPositiveInteger(environment, "ANALYSIS_MAX_PROVENANCE_HOPS"),
    maxTargetedRetrievalRounds: readNonNegativeInteger(
      environment,
      "ANALYSIS_MAX_TARGETED_RETRIEVAL_ROUNDS",
    ),
    maxElapsedMs: readPositiveInteger(environment, "ANALYSIS_MAX_ELAPSED_MS"),
    maxConcurrentExternalCalls: readPositiveInteger(
      environment,
      "ANALYSIS_MAX_CONCURRENT_EXTERNAL_CALLS",
    ),
    maxCostUsd: readPositiveMoney(environment, "ANALYSIS_MAX_COST_USD"),
  };
  const invalid = Object.entries(values).find(([, value]) => value === null);
  if (invalid) {
    return {
      ok: false as const,
      message: `The focused runtime requires an explicit ${invalid[0]} budget setting.`,
    };
  }
  if (values.maxElapsedMs! > 300_000) {
    return {
      ok: false as const,
      message: "ANALYSIS_MAX_ELAPSED_MS cannot exceed the 300-second analysis attempt bound.",
    };
  }
  return { ok: true as const, value: values as RunBudget };
}

function readLiveSpend(environment: RuntimeEnvironment) {
  const names = [
    "AI_DAILY_SPEND_LIMIT_USD",
    "AI_ESTIMATED_GENERATION_COST_USD",
    "AI_ESTIMATED_IMAGE_COST_USD",
    "AI_ESTIMATED_EMBEDDING_COST_USD",
  ];
  const missing = names.find((name) => readPositiveMoney(environment, name) === null);
  return missing
    ? {
        ok: false as const,
        message: `The focused runtime requires an explicit positive ${missing} spend setting.`,
      }
    : { ok: true as const };
}

function readPositiveInteger(environment: RuntimeEnvironment, name: string) {
  const value = optional(environment, name);
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function readNonNegativeInteger(environment: RuntimeEnvironment, name: string) {
  const value = optional(environment, name);
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function readPositiveMoney(environment: RuntimeEnvironment, name: string) {
  const value = optional(environment, name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function optional(environment: RuntimeEnvironment, name: string) {
  const value = environment[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unavailable(message: string): AnalysisRuntimePolicyResult {
  return { enabled: false, code: "analysis_unavailable", message };
}

function testVersions(): RunContext["versions"] {
  return {
    engine: ANALYSIS_ENGINE_VERSION,
    prompt: "tracera-test-fixture-prompts-1.0.0",
    model: "test-fixture-model",
    retriever: ANALYSIS_RETRIEVER_VERSION,
    embedding: {
      model: "test-fixture-embedding",
      dimensions: EMBEDDING_DIMENSIONS,
      preprocessing: ANALYSIS_EMBEDDING_PREPROCESSING,
    },
    calibration: null,
  };
}

export function analysisRunContext(
  ownerUserId: string,
  input: RunInput,
  policy: AnalysisRuntimePolicy,
): RunContext {
  return runContextSchema.parse({
    runId: crypto.randomUUID(),
    tenantId: `user:${ownerUserId}`,
    ownerUserId,
    visibility: "private",
    inputHash: hashValue(input),
    asOfTime: new Date().toISOString(),
    versions: policy.versions,
    ...(policy.providerIdentity ? { provider: policy.providerIdentity } : {}),
    executionMode: policy.mode,
    budget: policy.budget,
    cancellation: { requested: false, requestedAt: null, reason: null },
    auditSinkId: `analysis-audit:${ownerUserId}`,
  });
}
