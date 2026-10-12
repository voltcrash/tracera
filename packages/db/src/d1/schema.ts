import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  real,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { DocumentSnapshot, RunContext, RunReport, StageName } from "@repo/contracts/analysis";

import { users, sessions, accounts, verifications } from "./auth-schema.js";
export { users, sessions, accounts, verifications };

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

export const analysisSnapshots = sqliteTable(
  "core_snapshots",
  {
    snapshotId: text("snapshot_id").notNull(),
    ...ownershipColumns(),
    contentHash: text("content_hash").notNull(),
    rawContentHash: text("raw_content_hash"),
    normalizedText: text("normalized_text"),
    snapshot: text("snapshot", { mode: "json" }).$type<DocumentSnapshot>(),
    snapshotHash: text("snapshot_hash").notNull(),
    snapshotBlobUri: text("snapshot_blob_uri"),
    blobStatus: text("blob_status", { enum: ["stored", "unavailable"] }).notNull(),
    blobUri: text("blob_uri"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.ownerUserId, table.visibility, table.snapshotId],
    }),
    index("core_snapshots_content_lookup_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.contentHash,
    ),
    check(
      "core_snapshots_visibility_check",
      sql`${table.visibility} IN ('private','unlisted','public')`,
    ),
    check(
      "core_snapshots_blob_check",
      sql`(${table.blobStatus} = 'stored' AND ${table.blobUri} IS NOT NULL) OR (${table.blobStatus} = 'unavailable' AND ${table.blobUri} IS NULL)`,
    ),
    check(
      "core_snapshots_storage_check",
      sql`(${table.snapshot} IS NOT NULL) <> (${table.snapshotBlobUri} IS NOT NULL)`,
    ),
  ],
);

export const analysisReportVersions = sqliteTable(
  "core_report_versions",
  {
    runId: text("run_id").notNull(),
    version: integer("version").notNull(),
    ...ownershipColumns(),
    reportHash: text("report_hash").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    contractVersion: text("contract_version").notNull(),
    engineVersion: text("engine_version").notNull(),
    diagnosticLabels: text("diagnostic_labels", { mode: "json" }).$type<string[]>().notNull(),
    publishedLabels: text("published_labels", { mode: "json" }).$type<string[]>().notNull(),
    factualScore: real("factual_score"),
    scoreNullReasons: text("score_null_reasons", { mode: "json" }).$type<string[]>().notNull(),
    evidenceSetHash: text("evidence_set_hash"),
    report: text("report", { mode: "json" }).$type<RunReport>(),
    reportBlobUri: text("report_blob_uri"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.version] }),
    uniqueIndex("core_report_versions_hash_idx").on(table.runId, table.reportHash),
    uniqueIndex("core_report_versions_scope_idx").on(
      table.runId,
      table.version,
      table.tenantId,
      table.ownerUserId,
      table.visibility,
    ),
    index("core_report_versions_owner_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.runId,
      table.version,
    ),
    foreignKey({
      columns: [table.runId, table.tenantId, table.ownerUserId, table.visibility],
      foreignColumns: [
        analysisRuns.runId,
        analysisRuns.tenantId,
        analysisRuns.ownerUserId,
        analysisRuns.visibility,
      ],
    }).onDelete("restrict"),
    check(
      "core_report_versions_storage_check",
      sql`(${table.report} IS NOT NULL) <> (${table.reportBlobUri} IS NOT NULL)`,
    ),
    check("core_report_versions_version_check", sql`${table.version} > 0`),
  ],
);

export const analysisReportClaims = sqliteTable(
  "core_report_claims",
  {
    runId: text("run_id").notNull(),
    reportVersion: integer("report_version").notNull(),
    claimId: text("claim_id").notNull(),
    ...ownershipColumns(),
    claim: text("claim", { mode: "json" }).$type<RunReport["claims"][number]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.reportVersion, table.claimId] }),
    foreignKey({
      columns: [
        table.runId,
        table.reportVersion,
        table.tenantId,
        table.ownerUserId,
        table.visibility,
      ],
      foreignColumns: [
        analysisReportVersions.runId,
        analysisReportVersions.version,
        analysisReportVersions.tenantId,
        analysisReportVersions.ownerUserId,
        analysisReportVersions.visibility,
      ],
    }).onDelete("restrict"),
  ],
);

export const analysisReportSnapshots = sqliteTable(
  "core_report_snapshots",
  {
    runId: text("run_id").notNull(),
    reportVersion: integer("report_version").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    ...ownershipColumns(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.reportVersion, table.snapshotId] }),
    index("core_report_snapshots_snapshot_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.snapshotId,
    ),
    foreignKey({
      columns: [
        table.runId,
        table.reportVersion,
        table.tenantId,
        table.ownerUserId,
        table.visibility,
      ],
      foreignColumns: [
        analysisReportVersions.runId,
        analysisReportVersions.version,
        analysisReportVersions.tenantId,
        analysisReportVersions.ownerUserId,
        analysisReportVersions.visibility,
      ],
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.ownerUserId, table.visibility, table.snapshotId],
      foreignColumns: [
        analysisSnapshots.tenantId,
        analysisSnapshots.ownerUserId,
        analysisSnapshots.visibility,
        analysisSnapshots.snapshotId,
      ],
    }).onDelete("restrict"),
  ],
);

export const analysisEvidenceAssessments = sqliteTable(
  "core_evidence_assessments",
  {
    runId: text("run_id").notNull(),
    reportVersion: integer("report_version").notNull(),
    assessmentId: text("assessment_id").notNull(),
    claimId: text("claim_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    ...ownershipColumns(),
    assessment: text("assessment", { mode: "json" })
      .$type<RunReport["assessments"][number]>()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.reportVersion, table.assessmentId] }),
    index("core_assessments_claim_idx").on(table.runId, table.reportVersion, table.claimId),
    foreignKey({
      columns: [
        table.runId,
        table.reportVersion,
        table.tenantId,
        table.ownerUserId,
        table.visibility,
      ],
      foreignColumns: [
        analysisReportVersions.runId,
        analysisReportVersions.version,
        analysisReportVersions.tenantId,
        analysisReportVersions.ownerUserId,
        analysisReportVersions.visibility,
      ],
    }).onDelete("restrict"),
  ],
);

export const analysisProvenanceEdges = sqliteTable(
  "core_provenance_edges",
  {
    runId: text("run_id").notNull(),
    reportVersion: integer("report_version").notNull(),
    claimId: text("claim_id").notNull(),
    edgeIndex: integer("edge_index").notNull(),
    ...ownershipColumns(),
    fromSnapshotId: text("from_snapshot_id").notNull(),
    toSnapshotId: text("to_snapshot_id").notNull(),
    edge: text("edge", { mode: "json" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.reportVersion, table.claimId, table.edgeIndex] }),
    index("core_provenance_edges_snapshots_idx").on(
      table.runId,
      table.fromSnapshotId,
      table.toSnapshotId,
    ),
    foreignKey({
      columns: [
        table.runId,
        table.reportVersion,
        table.tenantId,
        table.ownerUserId,
        table.visibility,
      ],
      foreignColumns: [
        analysisReportVersions.runId,
        analysisReportVersions.version,
        analysisReportVersions.tenantId,
        analysisReportVersions.ownerUserId,
        analysisReportVersions.visibility,
      ],
    }).onDelete("restrict"),
  ],
);

export const analysisDecisions = sqliteTable(
  "core_decisions",
  {
    runId: text("run_id").notNull(),
    reportVersion: integer("report_version").notNull(),
    claimId: text("claim_id").notNull(),
    ...ownershipColumns(),
    diagnosticLabel: text("diagnostic_label").notNull(),
    publishedLabel: text("published_label").notNull(),
    decision: text("decision", { mode: "json" }).$type<RunReport["decisions"][number]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.reportVersion, table.claimId] }),
    foreignKey({
      columns: [
        table.runId,
        table.reportVersion,
        table.tenantId,
        table.ownerUserId,
        table.visibility,
      ],
      foreignColumns: [
        analysisReportVersions.runId,
        analysisReportVersions.version,
        analysisReportVersions.tenantId,
        analysisReportVersions.ownerUserId,
        analysisReportVersions.visibility,
      ],
    }).onDelete("restrict"),
  ],
);

export const analysisRateLimits = sqliteTable(
  "analysis_rate_limits",
  {
    scopeType: text("scope_type", { enum: ["user", "ip"] }).notNull(),
    scopeKey: text("scope_key").notNull(),
    windowStartedAt: integer("window_started_at", { mode: "timestamp_ms" }).notNull(),
    requestCount: integer("request_count").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.scopeType, table.scopeKey] }),
    check("analysis_rate_limits_count_check", sql`${table.requestCount} >= 0`),
  ],
);

export const analysisLeases = sqliteTable(
  "analysis_leases",
  {
    id: text("id")
      .$defaultFn(() => crypto.randomUUID())
      .primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ipHash: text("ip_hash").notNull(),
    endpoint: text("endpoint").notNull(),
    idempotencyKey: text("idempotency_key"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    releasedAt: integer("released_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (table) => [
    index("analysis_leases_user_active_idx").on(table.userId, table.releasedAt, table.expiresAt),
    index("analysis_leases_ip_active_idx").on(table.ipHash, table.releasedAt, table.expiresAt),
  ],
);

export const analysisIdempotencyKeys = sqliteTable(
  "analysis_idempotency_keys",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    requestStatus: text("request_status", {
      enum: ["in_progress", "completed", "failed"],
    }).notNull(),
    responseBody: text("response_body", { mode: "json" }),
    responseBlobUri: text("response_blob_uri"),
    responseHash: text("response_hash"),
    responseStatus: integer("response_status"),
    // The claim precedes its guarded admission lease write in the same batch.
    leaseId: text("lease_id"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.endpoint, table.idempotencyKey] }),
    index("analysis_idempotency_expires_idx").on(table.expiresAt),
    check(
      "analysis_idempotency_storage_check",
      sql`NOT (${table.responseBody} IS NOT NULL AND ${table.responseBlobUri} IS NOT NULL)`,
    ),
  ],
);

export const analysisDailyQuotas = sqliteTable(
  "analysis_daily_quotas",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    periodStart: text("period_start").notNull(),
    requestCount: integer("request_count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.periodStart] }),
    check("analysis_daily_quotas_count_check", sql`${table.requestCount} >= 0`),
  ],
);
