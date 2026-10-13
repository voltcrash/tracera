import { personalProviderConfig, type ResolvedAnalysisProvider } from "@repo/ai";
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
