import {
  resolveAnalysisProvider,
  type AiProviderConfig,
  type AnalysisProviderEnvironment,
  type ResolvedAnalysisProvider,
} from "@repo/ai";
import { hashValue } from "@repo/ai/analysis/hashing";
import type { RunInput } from "@repo/ai/analysis/types";
import {
  ANALYSIS_EVALUATION_BUDGET,
  runContextSchema,
  type RunBudget,
  type RunContext,
} from "@repo/contracts/analysis";
import type { ServerEnv } from "./env";

import { analysisRuntimeVersions } from "./analysis-runtime-versions";
import {
  createFixtureExecutionPlan,
  createLiveExecutionPlan,
  type ExecutionPlan,
} from "./analysis-execution-plan";

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
  executionPlan: ExecutionPlan;
}

export type AnalysisRuntimePolicyResult =
  | { enabled: true; policy: AnalysisRuntimePolicy }
  | { enabled: false; code: "analysis_unavailable"; message: string };

function livePolicy(
  environment: RuntimeEnvironment,
  userId: string,
  selection?: ResolvedAnalysisProvider,
): AnalysisRuntimePolicyResult {
  let resolved: ReturnType<typeof resolveAnalysisProvider>;
  try {
    resolved =
      selection ??
      resolveAnalysisProvider({ userId, env: environment as AnalysisProviderEnvironment });
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
  const spend = readLiveSpend(environment, resolved.source === "user");
  if (!spend.ok) return unavailable(spend.message);
  const versions = analysisRuntimeVersions("live", model, embeddingModel);
  let executionPlan;
  try {
    executionPlan = createLiveExecutionPlan({
      resolved,
      versions,
      estimates: {
        generationCostUsd: Number(optional(environment, "AI_ESTIMATED_GENERATION_COST_USD")),
        imageCostUsd: Number(optional(environment, "AI_ESTIMATED_IMAGE_COST_USD")),
        embeddingCostUsd: Number(optional(environment, "AI_ESTIMATED_EMBEDDING_COST_USD")),
      },
      discovery: {
        googleFactCheck: Boolean(optional(environment, "GOOGLE_FACT_CHECK_API_KEY")),
        newsApi: Boolean(optional(environment, "NEWS_API_KEY")),
      },
    });
  } catch {
    return unavailable("The live runtime configuration is unsupported.");
  }

  return {
    enabled: true,
    policy: {
      mode: "live",
      providerConfig,
      providerIdentity: {
        source: resolved.source,
        provider: providerConfig.provider,
        ...(resolved.revisionId ? { revisionId: resolved.revisionId } : {}),
      },
      versions,
      executionPlan,
      budget: budget.value,
    },
  };
}

/** Fixture analysis runs the scripted ports offline and only in local development. */
export function analysisPolicy(
  env: Pick<ServerEnv, "MODE" | "ANALYSIS_MODE"> & RuntimeEnvironment,
  userId: string,
  selection?: ResolvedAnalysisProvider,
): AnalysisRuntimePolicyResult {
  if (env.ANALYSIS_MODE === "fixture") {
    if (env.MODE !== "dev") return unavailable("Fixture analysis runs only in local development.");
    const versions = testVersions();
    return {
      enabled: true,
      policy: {
        mode: "fixture",
        providerConfig: null,
        versions,
        executionPlan: createFixtureExecutionPlan(versions),
        budget: TEST_FOCUSED_BUDGET,
      },
    };
  }
  return livePolicy(env, userId, selection);
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
      message: "ANALYSIS_MAX_ELAPSED_MS cannot exceed the 300-second run bound.",
    };
  }
  return { ok: true as const, value: values as RunBudget };
}

function readLiveSpend(environment: RuntimeEnvironment, personal = false) {
  const names = [
    ...(personal ? [] : ["AI_DAILY_SPEND_LIMIT_USD"]),
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
  return analysisRuntimeVersions("fixture", "test-fixture-model", "test-fixture-embedding");
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
