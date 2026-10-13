import { and, eq } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { createD1Database } from "./index.js";
import { userProviderKeys } from "./provider-key-schema.js";

type StoredKey = typeof userProviderKeys.$inferSelect;
export type UserProviderKeyMetadata = Omit<
  StoredKey,
  "ciphertext" | "iv" | "encryptionVersion" | "userId"
>;
export type UserProviderKeyRecord = StoredKey;

const metadata = {
  provider: userProviderKeys.provider,
  baseUrl: userProviderKeys.baseUrl,
  model: userProviderKeys.model,
  embeddingProvider: userProviderKeys.embeddingProvider,
  embeddingBaseUrl: userProviderKeys.embeddingBaseUrl,
  embeddingModel: userProviderKeys.embeddingModel,
  fingerprint: userProviderKeys.fingerprint,
  status: userProviderKeys.status,
  createdAt: userProviderKeys.createdAt,
  lastUsedAt: userProviderKeys.lastUsedAt,
};

export function createD1ProviderKeyRepository(database: D1Database) {
  const db = createD1Database(database);
  return {
    async list(userId: string): Promise<UserProviderKeyMetadata[]> {
      return db
        .select(metadata)
        .from(userProviderKeys)
        .where(eq(userProviderKeys.userId, userId))
        .orderBy(userProviderKeys.provider);
    },
    async activeMetadata(userId: string): Promise<UserProviderKeyMetadata | null> {
      const rows = await db
        .select(metadata)
        .from(userProviderKeys)
        .where(and(eq(userProviderKeys.userId, userId), eq(userProviderKeys.status, "active")))
        .limit(1);
      return rows[0] ?? null;
    },
    async activeRecord(userId: string): Promise<UserProviderKeyRecord | null> {
      const rows = await db
        .select()
        .from(userProviderKeys)
        .where(and(eq(userProviderKeys.userId, userId), eq(userProviderKeys.status, "active")))
        .limit(1);
      return rows[0] ?? null;
    },
    async save(
      userId: string,
      key: Omit<StoredKey, "userId" | "status" | "createdAt" | "lastUsedAt">,
    ) {
      await db.batch([
        db
          .update(userProviderKeys)
          .set({ status: "inactive" })
          .where(eq(userProviderKeys.userId, userId)),
        db
          .insert(userProviderKeys)
          .values({ ...key, userId, status: "active", createdAt: new Date() })
          .onConflictDoUpdate({
            target: [userProviderKeys.userId, userProviderKeys.provider],
            set: { ...key, status: "active", lastUsedAt: null },
          }),
      ]);
    },
    async activate(userId: string, provider: StoredKey["provider"]): Promise<boolean> {
      const result = await database.batch([
        database
          .prepare(
            "UPDATE user_provider_keys SET status='inactive' WHERE user_id=? AND EXISTS(SELECT 1 FROM user_provider_keys WHERE user_id=? AND provider=?)",
          )
          .bind(userId, userId, provider),
        database
          .prepare("UPDATE user_provider_keys SET status='active' WHERE user_id=? AND provider=?")
          .bind(userId, provider),
      ]);
      return result[1]!.meta.changes > 0;
    },
    async delete(userId: string, provider: StoredKey["provider"]) {
      await db
        .delete(userProviderKeys)
        .where(and(eq(userProviderKeys.userId, userId), eq(userProviderKeys.provider, provider)));
    },
    async markUsed(userId: string, provider: StoredKey["provider"], ciphertext: string) {
      await db
        .update(userProviderKeys)
        .set({ lastUsedAt: new Date() })
        .where(
          and(
            eq(userProviderKeys.userId, userId),
            eq(userProviderKeys.provider, provider),
            eq(userProviderKeys.ciphertext, ciphertext),
          ),
        );
    },
  };
}
