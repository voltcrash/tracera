import { createAiProvider, resolveAnalysisProvider } from "@repo/ai";
import { createFixtureAnalysisPorts } from "@repo/ai/fixtures";
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

export function createWorkflowAnalysisPorts(input: {
  env: ServerEnv;
  context: RunContext;
  clock: ClockPort;
  blobStore: RawBlobStore;
}) {
  const { env, context, clock, blobStore } = input;
  if (context.executionMode === "fixture") {
    if (env.MODE !== "dev") throw new Error("Fixture analysis runs only in local development.");
    return createFixtureAnalysisPorts({ clock, rawBlobStore: blobStore });
  }
  const resolved = resolveAnalysisProvider({ userId: context.ownerUserId, env });
  if (
    resolved.config.model !== context.versions.model ||
    resolved.config.provider !== context.provider?.provider
  )
    throw new Error("The run's provider configuration has changed.");
  const controls = analysisControlConfig(env);
  const spend = createD1SpendRepository({ database: env.DB } as unknown as D1RepositoryOptions);
  const provider = spendLimitedAiProvider(
    createAiProvider(resolved.config),
    resolved.config,
    controls,
    spend,
  );
  const documents = createDocumentAcquisitionPort({
    now: () => clock.now(),
    monotonicMs: () => clock.monotonicMs(),
    rawBlobStore: blobStore,
    ocr: createProviderOcrPort({ provider, modelId: context.versions.model }),
    ocrCostUsd: controls.imageCostUsd,
  });
  return {
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
    search: createLiveSearchPorts(env, clock),
    documents: {
      ...documents,
      async acquire(request: Parameters<typeof documents.acquire>[0]) {
        const result = await documents.acquire(request);
        return { ...result, metrics: { ...result.metrics, costUsd: result.metrics.costUsd ?? 0 } };
      },
    },
  };
}
