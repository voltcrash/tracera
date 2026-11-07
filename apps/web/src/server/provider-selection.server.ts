import {
  decryptProviderKey,
  personalProviderConfig,
  resolveAnalysisProvider,
  type ResolvedAnalysisProvider,
} from "@repo/ai";
import type { RunContext } from "@repo/contracts/analysis";
import type { ServerEnv } from "./env";
import { providerKeyStorage } from "./provider-keys.server";

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
): Promise<ResolvedAnalysisProvider> {
  if (context.provider?.source !== "user")
    return resolveAnalysisProvider({ userId: context.ownerUserId, env });
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
  await storage.markUsed(context.ownerUserId, key.id);
  return { ...resolved, revisionId: key.id };
}
