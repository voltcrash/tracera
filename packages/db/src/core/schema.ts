import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
  varchar,
} from "drizzle-orm/pg-core";

const ownershipColumns = () => ({
  tenantId: text("tenant_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  visibility: varchar("visibility", { length: 16 }).notNull(),
});

export const coreRuns = pgTable(
  "core_runs",
  {
    runId: text("run_id").primaryKey(),
    ...ownershipColumns(),
    inputHash: varchar("input_hash", { length: 71 }).notNull(),
    asOfTime: timestamp("as_of_time", { withTimezone: true }).notNull(),
    executionMode: varchar("execution_mode", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("unavailable"),
    versions: jsonb("versions").notNull(),
    budget: jsonb("budget").notNull(),
    cancellation: jsonb("cancellation").notNull(),
    auditSinkId: text("audit_sink_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => [
    index("core_runs_owner_created_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.createdAt,
    ),
    check(
      "core_runs_visibility_check",
      sql`${table.visibility} IN ('private', 'unlisted', 'public')`,
    ),
    check(
      "core_runs_status_check",
      sql`${table.status} IN ('complete', 'partial', 'unavailable', 'failed', 'canceled')`,
    ),
  ],
);

export const coreJobs = pgTable(
  "core_jobs",
  {
    jobId: text("job_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => coreRuns.runId, { onDelete: "cascade" }),
    ...ownershipColumns(),
    stage: varchar("stage", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("queued"),
    payload: jsonb("payload").notNull(),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    fencingToken: text("fencing_token"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    cancellationRequested: boolean("cancellation_requested").notNull().default(false),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("core_jobs_run_stage_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.runId,
      table.stage,
    ),
    index("core_jobs_available_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
    check(
      "core_jobs_status_check",
      sql`${table.status} IN ('queued', 'leased', 'retry', 'complete', 'failed', 'canceled')`,
    ),
    check("core_jobs_attempt_check", sql`${table.attempt} >= 0 AND ${table.maxAttempts} > 0`),
    check(
      "core_jobs_lease_state_check",
      sql`(${table.status} = 'leased') = (${table.fencingToken} IS NOT NULL AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
  ],
);

export const coreStageAttempts = pgTable(
  "core_stage_attempts",
  {
    runId: text("run_id")
      .notNull()
      .references(() => coreRuns.runId, { onDelete: "cascade" }),
    stage: varchar("stage", { length: 32 }).notNull(),
    attempt: integer("attempt").notNull(),
    ...ownershipColumns(),
    fencingToken: text("fencing_token").notNull(),
    workerId: text("worker_id").notNull(),
    leaseStartedAt: timestamp("lease_started_at", { withTimezone: true }).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: varchar("outcome", { length: 16 }),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.stage, table.attempt] }),
    uniqueIndex("core_stage_attempts_fence_idx").on(table.fencingToken),
    index("core_stage_attempts_owner_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.runId,
    ),
  ],
);

export const coreStageCheckpoints = pgTable(
  "core_stage_checkpoints",
  {
    runId: text("run_id")
      .notNull()
      .references(() => coreRuns.runId, { onDelete: "cascade" }),
    stage: varchar("stage", { length: 32 }).notNull(),
    ...ownershipColumns(),
    attempt: integer("attempt").notNull(),
    fencingToken: text("fencing_token").notNull(),
    checkpointHash: varchar("checkpoint_hash", { length: 71 }).notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.stage] }),
    index("core_stage_checkpoints_owner_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.runId,
    ),
  ],
);

export const coreSnapshots = pgTable(
  "core_snapshots",
  {
    snapshotId: text("snapshot_id").notNull(),
    ...ownershipColumns(),
    contentHash: varchar("content_hash", { length: 71 }).notNull(),
    rawContentHash: varchar("raw_content_hash", { length: 71 }),
    normalizedText: text("normalized_text").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    blobStatus: varchar("blob_status", { length: 16 }).notNull(),
    blobUri: text("blob_uri"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.ownerUserId, table.visibility, table.snapshotId],
    }),
    uniqueIndex("core_snapshots_content_identity_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.contentHash,
      table.snapshotId,
    ),
    index("core_snapshots_content_lookup_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.contentHash,
    ),
    check(
      "core_snapshots_visibility_check",
      sql`${table.visibility} IN ('private', 'unlisted', 'public')`,
    ),
    check(
      "core_snapshots_blob_check",
      sql`(${table.blobStatus} = 'stored' AND ${table.blobUri} IS NOT NULL) OR (${table.blobStatus} = 'unavailable' AND ${table.blobUri} IS NULL)`,
    ),
  ],
);

export const coreSnapshotEmbeddings = pgTable(
  "core_snapshot_embeddings",
  {
    snapshotId: text("snapshot_id").notNull(),
    ...ownershipColumns(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    preprocessing: text("preprocessing").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.ownerUserId,
        table.visibility,
        table.snapshotId,
        table.model,
        table.dimensions,
        table.preprocessing,
      ],
    }),
    check("core_snapshot_embeddings_dimensions_check", sql`${table.dimensions} = 1024`),
    foreignKey({
      columns: [table.tenantId, table.ownerUserId, table.visibility, table.snapshotId],
      foreignColumns: [
        coreSnapshots.tenantId,
        coreSnapshots.ownerUserId,
        coreSnapshots.visibility,
        coreSnapshots.snapshotId,
      ],
      name: "core_snapshot_embeddings_snapshot_fk",
    }).onDelete("cascade"),
  ],
);

export const coreReportVersions = pgTable(
  "core_report_versions",
  {
    runId: text("run_id")
      .notNull()
      .references(() => coreRuns.runId, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    ...ownershipColumns(),
    reportHash: varchar("report_hash", { length: 71 }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    contractVersion: text("contract_version").notNull(),
    engineVersion: text("engine_version").notNull(),
    diagnosticLabels: jsonb("diagnostic_labels").notNull(),
    publishedLabels: jsonb("published_labels").notNull(),
    factualScore: numeric("factual_score", { precision: 8, scale: 5 }),
    scoreNullReasons: jsonb("score_null_reasons").notNull(),
    evidenceSetHash: varchar("evidence_set_hash", { length: 71 }),
    report: jsonb("report").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.version] }),
    uniqueIndex("core_report_versions_hash_idx").on(table.runId, table.reportHash),
    index("core_report_versions_owner_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.runId,
      table.version,
    ),
  ],
);

export const coreReportClaims = pgTable(
  "core_report_claims",
  {
    runId: text("run_id").notNull(),
    reportVersion: integer("report_version").notNull(),
    claimId: text("claim_id").notNull(),
    ...ownershipColumns(),
    claim: jsonb("claim").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.reportVersion, table.claimId] })],
);

export const coreReportSnapshots = pgTable(
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
      columns: [table.tenantId, table.ownerUserId, table.visibility, table.snapshotId],
      foreignColumns: [
        coreSnapshots.tenantId,
        coreSnapshots.ownerUserId,
        coreSnapshots.visibility,
        coreSnapshots.snapshotId,
      ],
      name: "core_report_snapshots_snapshot_fk",
    }).onDelete("restrict"),
  ],
);

export const coreEvidenceAssessments = pgTable(
  "core_evidence_assessments",
  {
    runId: text("run_id").notNull(),
    reportVersion: integer("report_version").notNull(),
    assessmentId: text("assessment_id").notNull(),
    claimId: text("claim_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    ...ownershipColumns(),
    assessment: jsonb("assessment").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.reportVersion, table.assessmentId] }),
    index("core_assessments_claim_idx").on(table.runId, table.reportVersion, table.claimId),
  ],
);

export const coreProvenanceEdges = pgTable(
  "core_provenance_edges",
  {
    runId: text("run_id").notNull(),
    reportVersion: integer("report_version").notNull(),
    claimId: text("claim_id").notNull(),
    edgeIndex: integer("edge_index").notNull(),
    ...ownershipColumns(),
    fromSnapshotId: text("from_snapshot_id").notNull(),
    toSnapshotId: text("to_snapshot_id").notNull(),
    edge: jsonb("edge").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.reportVersion, table.claimId, table.edgeIndex] }),
    index("core_provenance_edges_snapshots_idx").on(
      table.runId,
      table.fromSnapshotId,
      table.toSnapshotId,
    ),
  ],
);

export const coreDecisions = pgTable(
  "core_decisions",
  {
    runId: text("run_id").notNull(),
    reportVersion: integer("report_version").notNull(),
    claimId: text("claim_id").notNull(),
    ...ownershipColumns(),
    diagnosticLabel: varchar("diagnostic_label", { length: 16 }).notNull(),
    publishedLabel: varchar("published_label", { length: 16 }).notNull(),
    decision: jsonb("decision").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.reportVersion, table.claimId] })],
);

export const coreOutbox = pgTable(
  "core_outbox",
  {
    id: text("id").primaryKey(),
    ...ownershipColumns(),
    runId: text("run_id")
      .notNull()
      .references(() => coreRuns.runId, { onDelete: "cascade" }),
    topic: varchar("topic", { length: 64 }).notNull(),
    deduplicationKey: text("deduplication_key").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("core_outbox_deduplication_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.visibility,
      table.deduplicationKey,
    ),
    index("core_outbox_pending_idx").on(table.publishedAt, table.createdAt),
  ],
);
