import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { RunContext, StageName } from "@repo/contracts/analysis";

export { users, sessions, accounts, verifications } from "./auth-schema.js";

const ownershipColumns = () => ({
  tenantId: text("tenant_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  visibility: text("visibility", { enum: ["private", "unlisted", "public"] }).notNull(),
});
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

export const analysisRuns = sqliteTable(
  "core_runs",
  {
    runId: text("run_id").primaryKey(),
    ...ownershipColumns(),
    inputHash: text("input_hash").notNull(),
    contextHash: text("context_hash").notNull(),
    asOfTime: integer("as_of_time", { mode: "timestamp_ms" }).notNull(),
    executionMode: text("execution_mode", { enum: ["fixture", "live"] }).notNull(),
    status: text("status", {
      enum: ["queued", "running", "complete", "partial", "unavailable", "failed", "canceled"],
    })
      .notNull()
      .default("queued"),
    stage: text("stage").$type<StageName>().notNull().default("normalize_input"),
    attempt: integer("attempt").notNull().default(0),
    fencingToken: text("fencing_token"),
    version: integer("version").notNull().default(0),
    versions: text("versions", { mode: "json" }).$type<RunContext["versions"]>().notNull(),
    budget: text("budget", { mode: "json" }).$type<RunContext["budget"]>().notNull(),
    cancellation: text("cancellation", { mode: "json" })
      .$type<RunContext["cancellation"]>()
      .notNull(),
    auditSinkId: text("audit_sink_id").notNull(),
    providerSource: text("provider_source", { enum: ["platform", "user"] }),
    provider: text("provider", {
      enum: ["anthropic", "gemini", "openai", "openrouter", "openai-compatible"],
    }),
    inputJson: text("input_json"),
    inputBlobUri: text("input_blob_uri"),
    inputPayloadHash: text("input_payload_hash"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finalizedAt: integer("finalized_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("core_runs_scope_idx").on(
      table.runId,
      table.tenantId,
      table.ownerUserId,
      table.visibility,
    ),
    index("core_runs_owner_created_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.createdAt,
    ),
    check(
      "core_runs_visibility_check",
      sql`${table.visibility} IN ('private','unlisted','public')`,
    ),
    check(
      "core_runs_status_check",
      sql`${table.status} IN ('queued','running','complete','partial','unavailable','failed','canceled')`,
    ),
    check("core_runs_attempt_check", sql`${table.attempt} >= 0 AND ${table.version} >= 0`),
    check(
      "core_runs_provider_pair_check",
      sql`(${table.providerSource} IS NULL) = (${table.provider} IS NULL)`,
    ),
    check(
      "core_runs_input_storage_check",
      sql`NOT (${table.inputJson} IS NOT NULL AND ${table.inputBlobUri} IS NOT NULL)`,
    ),
  ],
);

export const analysisStageAttempts = sqliteTable(
  "core_stage_attempts",
  {
    runId: text("run_id").notNull(),
    ...ownershipColumns(),
    stage: text("stage").$type<StageName>().notNull(),
    attempt: integer("attempt").notNull(),
    fencingToken: text("fencing_token").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    outcome: text("outcome", { enum: ["complete", "failed", "canceled"] }),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.stage, table.attempt] }),
    index("core_stage_attempts_owner_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.runId,
    ),
    foreignKey({
      columns: [table.runId, table.tenantId, table.ownerUserId, table.visibility],
      foreignColumns: [
        analysisRuns.runId,
        analysisRuns.tenantId,
        analysisRuns.ownerUserId,
        analysisRuns.visibility,
      ],
    }).onDelete("cascade"),
    check("core_stage_attempts_attempt_check", sql`${table.attempt} > 0`),
  ],
);

export const analysisStageCheckpoints = sqliteTable(
  "core_stage_checkpoints",
  {
    runId: text("run_id").notNull(),
    ...ownershipColumns(),
    stage: text("stage").$type<StageName>().notNull(),
    attempt: integer("attempt").notNull(),
    fencingToken: text("fencing_token").notNull(),
    checkpointHash: text("checkpoint_hash").notNull(),
    payloadJson: text("payload_json"),
    payloadBlobUri: text("payload_blob_uri"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.stage] }),
    index("core_stage_checkpoints_owner_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.runId,
    ),
    foreignKey({
      columns: [table.runId, table.tenantId, table.ownerUserId, table.visibility],
      foreignColumns: [
        analysisRuns.runId,
        analysisRuns.tenantId,
        analysisRuns.ownerUserId,
        analysisRuns.visibility,
      ],
    }).onDelete("cascade"),
    check(
      "core_stage_checkpoints_storage_check",
      sql`(${table.payloadJson} IS NOT NULL) <> (${table.payloadBlobUri} IS NOT NULL)`,
    ),
  ],
);
