import { randomUUID } from "node:crypto";
import { createAiProvider, type AiProviderConfig, type AiProviderName } from "../src/index.js";
import {
  createCoreEmbeddingPort,
  createCoreGenerationPort,
  createReservedExternalCall,
  createOperationalAudit,
  createRuntimeDocumentPort,
  createSystemClock,
  runCoreWorker,
} from "../src/core/index.js";
import {
  configureDatabase,
  EMBEDDING_DIMENSIONS,
  pool,
  reserveProviderSpend,
  settleProviderSpend,
} from "@repo/db";
import { CoreStorageRepository } from "@repo/db/core";

configureDatabase(process.env.DATABASE_URL, process.env);
const providerConfig = configuration(process.env);
const provider = createAiProvider(providerConfig);
const repository = new CoreStorageRepository(pool);
const controller = new AbortController();
const reservations = new Map<string, Set<string>>();
for (const event of ["SIGINT", "SIGTERM"] as const) {
  process.once(event, () => controller.abort(new Error(`Worker received ${event}.`)));
}

const estimatedUsd = estimatedCallCost(process.env);
await runCoreWorker({
  repository,
  workerId: `core-worker:${process.pid}:${randomUUID()}`,
  leaseSeconds: 60,
  reuseMaxAgeMs: 6 * 60 * 60 * 1_000,
  signal: controller.signal,
  createPorts({ lease }) {
    const clock = createSystemClock();
    const withExternalCall = createReservedExternalCall({
      runId: lease.runId,
      estimatedUsd,
      reserve: ({ reservationId }) =>
        reserveProviderSpend({
          providerKey: providerConfig.provider,
          estimatedUsd,
          dailyBudgetUsd: dailySpendLimit(process.env),
          reservationId,
        }),
      onReserved(reservationId) {
        const runReservations = reservations.get(lease.runId) ?? new Set<string>();
        runReservations.add(reservationId);
        reservations.set(lease.runId, runReservations);
      },
    });
    return {
      generation: createCoreGenerationPort({
        provider,
        modelId: lease.context.versions.model,
        promptVersion: lease.context.versions.prompt,
        withExternalCall,
      }),
      embeddings: createCoreEmbeddingPort({
        provider,
        modelId: lease.context.versions.embedding.model,
        dimensions: lease.context.versions.embedding.dimensions,
        preprocessing: lease.context.versions.embedding.preprocessing,
        withExternalCall,
      }),
      search: [],
      documents: createRuntimeDocumentPort(
        clock,
        providerConfig.provider === "fixture"
          ? async () => {
              throw new Error("Fixture-mode Core v2 document acquisition has no network fallback.");
            }
          : undefined,
      ),
      clock,
      audit: createOperationalAudit(lease.context.auditSinkId),
    };
  },
  async onTerminal(lease) {
    // Provider adapters do not report per-call cost, so each settled call is charged at its
    // reserved estimate rather than assumed free.
    for (const reservationId of reservations.get(lease.runId) ?? []) {
      await settleProviderSpend({ reservationId, actualUsd: estimatedUsd });
    }
    reservations.delete(lease.runId);
  },
  onError(error, lease) {
    console.error(
      JSON.stringify({
        event: "core_worker_error",
        runId: lease?.runId ?? null,
        message: error instanceof Error ? error.message : "Unknown worker error",
      }),
    );
  },
});
await pool.end();

function configuration(environment: NodeJS.ProcessEnv): AiProviderConfig {
  if (environment.TRACERA_ANALYSIS_MODE === "fixture") {
    return {
      provider: "fixture",
      model: "deterministic-fixture-v1",
      embeddingModel: "deterministic-fixture-1024-v1",
      embeddingDimensions: EMBEDDING_DIMENSIONS,
    };
  }
  const provider = providerName(required(environment, "AI_PROVIDER"));
  const apiKey = required(environment, "AI_API_KEY");
  return {
    provider,
    apiKey,
    model: optional(environment, "AI_MODEL"),
    baseUrl: optional(environment, "AI_BASE_URL"),
    embeddingModel: optional(environment, "AI_EMBEDDING_MODEL"),
    embeddingDimensions: EMBEDDING_DIMENSIONS,
  };
}

function providerName(value: string): AiProviderName {
  const names: AiProviderName[] = [
    "anthropic",
    "gemini",
    "openai",
    "openrouter",
    "openai-compatible",
  ];
  if (!names.includes(value as AiProviderName))
    throw new Error(`Unsupported worker provider: ${value}.`);
  return value as AiProviderName;
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = optional(environment, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optional(environment: NodeJS.ProcessEnv, name: string) {
  return environment[name]?.trim() || undefined;
}

function dailySpendLimit(environment: NodeJS.ProcessEnv) {
  return positiveMoney(environment.AI_DAILY_SPEND_LIMIT_USD, 25);
}

function estimatedCallCost(environment: NodeJS.ProcessEnv) {
  return positiveMoney(environment.AI_ESTIMATED_GENERATION_COST_USD, 0.01) * 2;
}

function positiveMoney(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
