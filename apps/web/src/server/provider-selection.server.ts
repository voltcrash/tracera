import {
  decryptProviderKey,
  personalProviderConfig,
  resolveAnalysisProvider,
  type ResolvedAnalysisProvider,
} from "@repo/ai";
import type { RunContext } from "@repo/contracts/analysis";
import type { ServerEnv } from "./env";
import { providerKeyStorage } from "./provider-keys.server";
import { hashValue } from "@repo/ai/analysis/hashing";
import {
  assertExecutionPlanContext,
  ExecutionPlanUnavailableError,
  providerPlan,
  type LiveExecutionPlan,
} from "./analysis-execution-plan";

export class ProviderRevisionUnavailableError extends Error {
  constructor() {
    super(
      "This run's provider key revision is unavailable. Update your key in Settings and start a new run.",
    );
    this.name = "ProviderRevisionUnavailableError";
  }
}

export async function personalProviderSelection(
  env: ServerEnv,
  userId: string,
): Promise<ResolvedAnalysisProvider | undefined> {
  const key = await providerKeyStorage(env).activeMetadata(userId);
  if (!key) return undefined;
  if (key.health !== "verified") throw new ProviderRevisionUnavailableError();
  if (!env.PROVIDER_KEYS_ENCRYPTION_KEY) throw new Error("Personal provider keys are unavailable.");
  return { source: "user", revisionId: key.id, config: personalProviderConfig(key) };
}

export async function resolveWorkflowProvider(
  env: ServerEnv,
  context: RunContext,
  plan?: LiveExecutionPlan,
): Promise<ResolvedAnalysisProvider> {
  if (plan) assertExecutionPlanContext(plan, context);
  if (context.provider?.source !== "user") {
    if (!plan) throw new ExecutionPlanUnavailableError();
    try {
      const separate = plan.provider.embedding.keySource === "embedding";
      const resolved = resolveAnalysisProvider({
        userId: context.ownerUserId,
        env: {
          AI_PROVIDER: env.AI_PROVIDER,
          AI_API_KEY: env.AI_API_KEY,
          AI_BASE_URL: env.AI_BASE_URL,
          AI_MODEL: plan.provider.generation.model,
          AI_EMBEDDING_MODEL: plan.provider.embedding.model,
          ...(separate
            ? {
                AI_EMBEDDING_PROVIDER: env.AI_EMBEDDING_PROVIDER,
                AI_EMBEDDING_API_KEY: env.AI_EMBEDDING_API_KEY,
                AI_EMBEDDING_BASE_URL: env.AI_EMBEDDING_BASE_URL,
              }
            : {}),
        },
      });
      if (hashValue(providerPlan(resolved)) !== hashValue(plan.provider))
        throw new ExecutionPlanUnavailableError();
      return resolved;
    } catch {
      throw new ExecutionPlanUnavailableError();
    }
  }
  const storage = providerKeyStorage(env);
  const key = context.provider.revisionId
    ? await storage.revision(context.ownerUserId, context.provider.revisionId)
    : null;
  if (
    !key ||
    key.health !== "verified" ||
    key.provider !== context.provider.provider ||
    key.model !== context.versions.model ||
    key.embeddingModel !== context.versions.embedding.model
  )
    throw new ProviderRevisionUnavailableError();
  const credentials = await decryptProviderKey({
    secret: env.PROVIDER_KEYS_ENCRYPTION_KEY,
    userId: context.ownerUserId,
    provider: key.provider,
    encrypted: key,
  }).catch(() => {
    throw new ProviderRevisionUnavailableError();
  });
  const resolved = resolveAnalysisProvider({
    userId: context.ownerUserId,
    env,
    userConfig: personalProviderConfig(key, credentials),
  });
  const bound = { ...resolved, revisionId: key.id };
  if (plan && hashValue(providerPlan(bound)) !== hashValue(plan.provider))
    throw new ExecutionPlanUnavailableError();
  await storage.markUsed(context.ownerUserId, key.id);
  return bound;
}
