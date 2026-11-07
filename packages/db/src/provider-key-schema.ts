import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth-schema.js";

const providers = ["anthropic", "gemini", "openai", "openrouter", "openai-compatible"] as const;

export const userProviderKeys = sqliteTable(
  "user_provider_keys",
  {
    id: text("id")
      .primaryKey()
      .default(sql`(lower(hex(randomblob(16))))`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: providers }).notNull(),
    baseUrl: text("base_url"),
    model: text("model").notNull(),
    embeddingProvider: text("embedding_provider", {
      enum: ["gemini", "openai", "openrouter", "openai-compatible"],
    }),
    embeddingBaseUrl: text("embedding_base_url"),
    embeddingModel: text("embedding_model").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    encryptionVersion: integer("encryption_version").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status", { enum: ["active", "inactive"] }).notNull(),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(true),
    health: text("health", { enum: ["verified", "rejected"] })
      .notNull()
      .default("verified"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("user_provider_keys_current_idx")
      .on(table.userId, table.provider)
      .where(sql`${table.isCurrent}=1`),
    uniqueIndex("user_provider_keys_active_idx")
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),
    check("user_provider_keys_version_check", sql`${table.encryptionVersion} > 0`),
    check("user_provider_keys_fingerprint_check", sql`length(${table.fingerprint}) = 4`),
    check("user_provider_keys_status_check", sql`${table.status} IN ('active','inactive')`),
    check(
      "user_provider_keys_current_check",
      sql`${table.isCurrent} IN (0,1) AND (${table.status}<>'active' OR ${table.isCurrent}=1)`,
    ),
    check("user_provider_keys_health_check", sql`${table.health} IN ('verified','rejected')`),
    check(
      "user_provider_keys_provider_check",
      sql`${table.provider} IN ('anthropic','gemini','openai','openrouter','openai-compatible')`,
    ),
    check(
      "user_provider_keys_embedding_provider_check",
      sql`${table.embeddingProvider} IS NULL OR ${table.embeddingProvider} IN ('gemini','openai','openrouter','openai-compatible')`,
    ),
  ],
);
