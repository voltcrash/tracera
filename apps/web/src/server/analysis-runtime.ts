import {
  createAiProvider,
  ProviderRequestError,
  InstrumentedAiProvider,
  ProviderKeyRejectedError,
  isProviderKeyRejection,
  type ResolvedAnalysisProvider,
} from "@repo/ai";
import { createFixtureAnalysisPorts } from "@repo/ai/fixtures";
import { hashValue } from "@repo/ai/analysis/hashing";
import {
  createAnalysisEmbeddingPort,
  createAnalysisGenerationPort,
  createProviderOcrPort,
  type ClockPort,
  type RawBlobStore,
} from "@repo/ai/analysis";
import { createDocumentAcquisitionPort } from "@repo/ai/analysis/ingestion";

import type { RunContext } from "@repo/contracts/analysis";
import { createD1SpendRepository, type D1RepositoryOptions } from "@repo/db";
import { analysisControlConfig, spendLimitedAiProvider } from "./analysis-controls";
import { createLiveSearchPorts } from "./evidence-search.server";
import type { ServerEnv } from "./env";
import { ProviderRevisionUnavailableError } from "./provider-selection.server";
import {
  assertExecutionPlanContext,
  createFixtureExecutionPlan,
  ExecutionPlanUnavailableError,
  providerPlan,
  type ExecutionPlan,
} from "./analysis-execution-plan";

export function createWorkflowAnalysisPorts(input: {
  env: ServerEnv;
  context: RunContext;
  executionPlan?: ExecutionPlan;
  clock: ClockPort;
  blobStore: RawBlobStore;
  resolvedProvider?: ResolvedAnalysisProvider;
  reserveUsage: (estimatedCostUsd: number) => Promise<void>;
  onProviderRejected?: () => Promise<void>;
}) {
  const { env, context, clock, blobStore } = input;
  const plan =
    input.executionPlan ??
    (context.executionMode === "fixture" ? createFixtureExecutionPlan(context.versions) : null);
  if (!plan) throw new ExecutionPlanUnavailableError();
  assertExecutionPlanContext(plan, context);
  if (plan.mode === "fixture") {
    if (env.MODE !== "dev") throw new ExecutionPlanUnavailableError();
    return {
      ...createFixtureAnalysisPorts({ clock, rawBlobStore: blobStore }),
      assertProviderAccepted() {},
    };
  }
  const resolved = input.resolvedProvider;
  if (!resolved) throw new ExecutionPlanUnavailableError();
  if (hashValue(providerPlan(resolved)) !== hashValue(plan.provider))
    throw new ExecutionPlanUnavailableError();
  const controls = analysisControlConfig(env);
  controls.generationCostUsd = Math.max(
    controls.generationCostUsd,
    plan.estimates.generationCostUsd,
  );
  controls.imageCostUsd = Math.max(controls.imageCostUsd, plan.estimates.imageCostUsd);
  controls.embeddingCostUsd = Math.max(controls.embeddingCostUsd, plan.estimates.embeddingCostUsd);
  if (
    resolved.source === "platform" &&
    !(
      Number(env.AI_DAILY_SPEND_LIMIT_USD) > 0 &&
      Number.isFinite(Number(env.AI_DAILY_SPEND_LIMIT_USD))
    )
  )
    throw new ExecutionPlanUnavailableError();
  const discoveryEnv = {
    GOOGLE_FACT_CHECK_API_KEY: plan.discovery.googleFactCheck
      ? env.GOOGLE_FACT_CHECK_API_KEY
      : undefined,
    NEWS_API_KEY: plan.discovery.newsApi ? env.NEWS_API_KEY : undefined,
  };
  if (
    (plan.discovery.googleFactCheck && !discoveryEnv.GOOGLE_FACT_CHECK_API_KEY?.trim()) ||
    (plan.discovery.newsApi && !discoveryEnv.NEWS_API_KEY?.trim())
  )
    throw new ExecutionPlanUnavailableError();
  const spend = createD1SpendRepository({ database: env.DB } as unknown as D1RepositoryOptions);
  let rejected = false;
  let unavailable: ProviderRevisionUnavailableError | ExecutionPlanUnavailableError | null = null;
  const assertProviderAccepted = () => {
    if (unavailable instanceof ProviderRevisionUnavailableError) throw unavailable;
    if (rejected) throw new ProviderKeyRejectedError();
    if (unavailable) throw unavailable;
  };
  const reserveUsage = async (cost: number) => {
    assertProviderAccepted();
    try {
      await input.reserveUsage(cost);
    } catch (error) {
      if (error instanceof ProviderRevisionUnavailableError) unavailable = error;
      throw error;
    }
  };
  const underlying = createAiProvider(resolved.config);
  const controlledProvider =
    resolved.source === "platform"
      ? spendLimitedAiProvider(underlying, resolved.config, controls, spend)
      : new InstrumentedAiProvider(underlying, {
          async onCall(_call, operation) {
            assertProviderAccepted();
            try {
              return await operation();
            } catch (error) {
              if (isProviderKeyRejection(error)) {
                rejected = true;
                await input.onProviderRejected?.().catch(() => undefined);
                throw new ProviderKeyRejectedError();
              }
              throw error;
            }
          },
        });
  const provider = new InstrumentedAiProvider(controlledProvider, {
    onCall: async (_call, operation) => {
      assertProviderAccepted();
      try {
        return await operation();
      } catch (error) {
        if (
          error instanceof ProviderRequestError &&
          error.status !== undefined &&
          [400, 404, 405, 413, 415, 422].includes(error.status)
        ) {
          unavailable ??= new ExecutionPlanUnavailableError();
          assertProviderAccepted();
        }
        throw error;
      }
    },
    onRequest: (call) =>
      reserveUsage(
        call.kind === "embed"
          ? controls.embeddingCostUsd
          : call.kind === "generate_image"
            ? controls.imageCostUsd
            : controls.generationCostUsd,
      ),
  });
  const documents = createDocumentAcquisitionPort({
    now: () => clock.now(),
    monotonicMs: () => clock.monotonicMs(),
    rawBlobStore: blobStore,
    ocr: createProviderOcrPort({ provider, modelId: context.versions.model }),
    ocrCostUsd: controls.imageCostUsd,
    safeFetchOptions: { beforeRequest: () => reserveUsage(0) },
  });
  return {
    assertProviderAccepted,
    generation: createAnalysisGenerationPort({
      provider,
      modelId: context.versions.model,
      promptVersion: context.versions.prompt,
      estimatedGenerationCostUsd: controls.generationCostUsd,
      estimatedImageCostUsd: controls.imageCostUsd,
    }),
    embeddings: createAnalysisEmbeddingPort({
      provider,
      ...context.versions.embedding,
      modelId: context.versions.embedding.model,
      estimatedCostUsd: controls.embeddingCostUsd,
    }),
    search: createLiveSearchPorts(discoveryEnv, clock, () => reserveUsage(0)),
    documents: {
      ...documents,
      async acquire(request: Parameters<typeof documents.acquire>[0]) {
        const result = await documents.acquire(request);
        return { ...result, metrics: { ...result.metrics, costUsd: result.metrics.costUsd ?? 0 } };
      },
    },
  };
}
