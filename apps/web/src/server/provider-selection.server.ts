import {
  decryptProviderKey,
  personalProviderConfig,
  resolveAnalysisProvider,
  type ResolvedAnalysisProvider,
} from "@repo/ai";
import type { RunContext } from "@repo/contracts/analysis";
import type { ServerEnv } from "./env";
import { providerKeyStorage } from "./provider-keys.server";

export async function personalProviderSelection(
  env: ServerEnv,
  userId: string,
): Promise<ResolvedAnalysisProvider | undefined> {
  const key = await providerKeyStorage(env).activeMetadata(userId);
  if (!key) return undefined;
  if (!env.PROVIDER_KEYS_ENCRYPTION_KEY) throw new Error("Personal provider keys are unavailable.");
  return { source: "user", config: personalProviderConfig(key) };
}

export async function resolveWorkflowProvider(
  env: ServerEnv,
  context: RunContext,
): Promise<ResolvedAnalysisProvider> {
  if (context.provider?.source !== "user")
    return resolveAnalysisProvider({ userId: context.ownerUserId, env });
  const storage = providerKeyStorage(env);
  const key = await storage.activeRecord(context.ownerUserId);
  if (
    !key ||
    key.provider !== context.provider.provider ||
    key.model !== context.versions.model ||
    key.embeddingModel !== context.versions.embedding.model
  )
    throw new Error("The run's personal provider settings have changed.");
  const credentials = await decryptProviderKey({
    secret: env.PROVIDER_KEYS_ENCRYPTION_KEY,
    userId: context.ownerUserId,
    provider: key.provider,
    encrypted: key,
  });
  const resolved = resolveAnalysisProvider({
    userId: context.ownerUserId,
    env,
    userConfig: personalProviderConfig(key, credentials),
  });
  await storage.markUsed(context.ownerUserId, key.provider, key.ciphertext);
  return resolved;
}
