import {
  encryptProviderKey,
  validateProviderKeyEncryption,
  ProviderKeyEncryptionError,
  ProviderKeyRejectedError,
  ProviderKeyVerificationError,
  providerKeyInputSchema,
  verifyProviderKey,
  type ProviderKeyInput,
} from "@repo/ai";
import { createD1ProviderKeyRepository } from "@repo/db";
import type { ServerEnv } from "./env";
import { ClientInputError } from "./error-handling";

export function providerKeyStorage(env: ServerEnv) {
  return createD1ProviderKeyRepository(
    env.DB as unknown as Parameters<typeof createD1ProviderKeyRepository>[0],
  );
}

export function validateProviderKeyInput(data: unknown): ProviderKeyInput {
  const parsed = providerKeyInputSchema.safeParse(data);
  if (!parsed.success)
    throw new ClientInputError(
      "Provide a supported provider, key, and both model names. Custom endpoints must use HTTPS; separate embeddings need their own key.",
    );
  return parsed.data;
}

export async function listProviderKeysForUser(env: ServerEnv, userId: string) {
  const keys = await providerKeyStorage(env).list(userId);
  let available = true;
  try {
    await validateProviderKeyEncryption(env.PROVIDER_KEYS_ENCRYPTION_KEY);
  } catch {
    available = false;
  }
  return { keys, available };
}

export async function saveProviderKeyForUser(
  env: ServerEnv,
  userId: string,
  data: unknown,
  verify = verifyProviderKey,
) {
  try {
    const input = validateProviderKeyInput(data);
    await validateProviderKeyEncryption(env.PROVIDER_KEYS_ENCRYPTION_KEY);
    await verify(input);
    const encrypted = await encryptProviderKey({
      secret: env.PROVIDER_KEYS_ENCRYPTION_KEY,
      userId,
      provider: input.provider,
      credentials: { apiKey: input.apiKey, embeddingApiKey: input.embeddingApiKey },
    });
    await providerKeyStorage(env).save(userId, {
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl ?? null,
      embeddingModel: input.embeddingModel,
      embeddingProvider: input.embeddingProvider ?? null,
      embeddingBaseUrl: input.embeddingBaseUrl ?? null,
      fingerprint: input.apiKey.slice(-4),
      ...encrypted,
    });
    return { ok: true as const };
  } catch (error) {
    const expected =
      error instanceof ClientInputError ||
      error instanceof ProviderKeyEncryptionError ||
      error instanceof ProviderKeyRejectedError ||
      error instanceof ProviderKeyVerificationError;
    return {
      ok: false as const,
      error: expected ? error.message : "Could not save your provider key. Please try again.",
    };
  }
}
