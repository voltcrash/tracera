import { randomUUID } from "node:crypto";
import {
  documentSnapshotSchema,
  runReportSchema,
  type DocumentSnapshot,
  type RunContext,
  type RunReport,
  type StageName,
} from "@repo/contracts/core-v2";

export type CoreVisibility = RunContext["visibility"];

export interface CoreAccessScope {
  tenantId: string;
  ownerUserId: string;
  visibility: CoreVisibility;
}

export interface CoreQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}

export interface CoreQueryable {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<CoreQueryResult<Row>>;
}

export interface CoreTransactionClient extends CoreQueryable {
  release(destroy?: boolean): void;
}

export interface CorePool extends CoreQueryable {
  connect(): Promise<CoreTransactionClient>;
}

export class CoreStorageConflictError extends Error {}
export class CoreStorageAccessError extends Error {}
export class StaleWorkerError extends Error {}

export interface CoreLease {
  jobId: string;
  runId: string;
  stage: StageName;
  payload: unknown;
  attempt: number;
  fencingToken: string;
  leaseExpiresAt: string;
  cancellationRequested: boolean;
}

export interface CoreOutboxRecord {
  id: string;
  runId: string;
  topic: string;
  payload: unknown;
  createdAt: string;
}

interface JobRow {
  job_id: string;
  run_id: string;
  stage: StageName;
  payload: unknown;
  attempt: number;
  fencing_token: string;
  lease_expires_at: string;
  cancellation_requested: boolean;
}

const scopeValues = (scope: CoreAccessScope) => [
  scope.tenantId,
  scope.ownerUserId,
  scope.visibility,
];

const changedOne = (result: CoreQueryResult) =>
  result.rowCount === 1 || (result.rowCount === undefined && result.rows.length === 1);

async function transaction<Value>(
  pool: CorePool,
  operation: (client: CoreTransactionClient) => Promise<Value>,
) {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const value = await operation(client);
    await client.query("COMMIT");
    open = false;
    return value;
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release(true);
  }
}

export class CoreStorageRepository {
  constructor(private readonly pool: CorePool) {}

  async enqueue(input: {
    context: RunContext;
    stage: StageName;
    payload: unknown;
    maxAttempts: number;
  }): Promise<{ jobId: string; created: boolean }> {
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer.");
    }
    const scope = input.context;
    const jobId = `${scope.runId}:${input.stage}`;
    return transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO core_runs
           (run_id, tenant_id, owner_user_id, visibility, input_hash, as_of_time,
            execution_mode, versions, budget, cancellation, audit_sink_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11)
         ON CONFLICT (run_id) DO NOTHING`,
        [
          scope.runId,
          scope.tenantId,
          scope.ownerUserId,
          scope.visibility,
          scope.inputHash,
          scope.asOfTime,
          scope.executionMode,
          JSON.stringify(scope.versions),
          JSON.stringify(scope.budget),
          JSON.stringify(scope.cancellation),
          scope.auditSinkId,
        ],
      );
      const owned = await client.query<{
        run_id: string;
        input_hash: string;
        execution_mode: string;
        same_versions: boolean;
        same_budget: boolean;
      }>(
        `SELECT run_id, input_hash, execution_mode,
                versions = $5::jsonb AS same_versions, budget = $6::jsonb AS same_budget
           FROM core_runs
          WHERE run_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4
          FOR UPDATE`,
        [
          scope.runId,
          ...scopeValues(scope),
          JSON.stringify(scope.versions),
          JSON.stringify(scope.budget),
        ],
      );
      const ownedRun = owned.rows[0];
      if (!ownedRun) throw new CoreStorageAccessError("Run is outside the caller scope.");
      if (
        ownedRun.input_hash !== scope.inputHash ||
        ownedRun.execution_mode !== scope.executionMode ||
        !ownedRun.same_versions ||
        !ownedRun.same_budget
      ) {
        throw new CoreStorageConflictError(
          "Run ID was already used with different immutable identity.",
        );
      }

      const inserted = await client.query<{ job_id: string }>(
        `INSERT INTO core_jobs
           (job_id, run_id, tenant_id, owner_user_id, visibility, stage, payload, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (tenant_id, owner_user_id, visibility, run_id, stage) DO NOTHING
         RETURNING job_id`,
        [
          jobId,
          scope.runId,
          scope.tenantId,
          scope.ownerUserId,
          scope.visibility,
          input.stage,
          JSON.stringify(input.payload),
          input.maxAttempts,
        ],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<{ same_payload: boolean; max_attempts: number }>(
          `SELECT payload = $6::jsonb AS same_payload, max_attempts FROM core_jobs
            WHERE run_id = $1 AND stage = $2
              AND tenant_id = $3 AND owner_user_id = $4 AND visibility = $5`,
          [scope.runId, input.stage, ...scopeValues(scope), JSON.stringify(input.payload)],
        );
        const existingJob = existing.rows[0];
        if (
          !existingJob ||
          !existingJob.same_payload ||
          existingJob.max_attempts !== input.maxAttempts
        ) {
          throw new CoreStorageConflictError(
            "Duplicate enqueue key was reused with a different payload or retry policy.",
          );
        }
      }
      await client.query(
        `INSERT INTO core_outbox
           (id, tenant_id, owner_user_id, visibility, run_id, topic, deduplication_key, payload)
         VALUES ($1, $2, $3, $4, $5, 'core.job.queued', $6, $7::jsonb)
         ON CONFLICT (tenant_id, owner_user_id, visibility, deduplication_key) DO NOTHING`,
        [
          `outbox:${jobId}`,
          scope.tenantId,
          scope.ownerUserId,
          scope.visibility,
          scope.runId,
          jobId,
          JSON.stringify({ jobId, runId: scope.runId, stage: input.stage }),
        ],
      );
      return { jobId, created: Boolean(inserted.rows[0]) };
    });
  }

  async acquireLease(input: {
    scope: CoreAccessScope;
    workerId: string;
    leaseSeconds: number;
  }): Promise<CoreLease | null> {
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1) {
      throw new Error("leaseSeconds must be a positive integer.");
    }
    return transaction(this.pool, async (client) => {
      const candidate = await client.query<{ job_id: string }>(
        `SELECT job_id FROM core_jobs
          WHERE tenant_id = $1 AND owner_user_id = $2 AND visibility = $3
            AND cancellation_requested = FALSE
            AND attempt < max_attempts
            AND available_at <= NOW()
            AND (status IN ('queued', 'retry') OR (status = 'leased' AND lease_expires_at <= NOW()))
          ORDER BY available_at, created_at, job_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        scopeValues(input.scope),
      );
      const jobId = candidate.rows[0]?.job_id;
      if (!jobId) return null;
      await client.query(
        `UPDATE core_stage_attempts AS attempt
            SET finished_at = NOW(), outcome = 'failed'
           FROM core_jobs AS job
          WHERE job.job_id = $1 AND job.status = 'leased' AND job.lease_expires_at <= NOW()
            AND attempt.run_id = job.run_id AND attempt.stage = job.stage
            AND attempt.attempt = job.attempt AND attempt.finished_at IS NULL
            AND attempt.tenant_id = $2 AND attempt.owner_user_id = $3 AND attempt.visibility = $4`,
        [jobId, ...scopeValues(input.scope)],
      );
      const fencingToken = randomUUID();
      const leased = await client.query<JobRow>(
        `UPDATE core_jobs
            SET status = 'leased', attempt = attempt + 1, fencing_token = $2,
                lease_owner = $3, lease_expires_at = NOW() + ($4 * INTERVAL '1 second'),
                updated_at = NOW()
          WHERE job_id = $1 AND tenant_id = $5 AND owner_user_id = $6 AND visibility = $7
          RETURNING job_id, run_id, stage, payload, attempt, fencing_token,
                    lease_expires_at::text, cancellation_requested`,
        [jobId, fencingToken, input.workerId, input.leaseSeconds, ...scopeValues(input.scope)],
      );
      const row = leased.rows[0];
      if (!row) throw new CoreStorageAccessError("Lease candidate left the caller scope.");
      await client.query(
        `INSERT INTO core_stage_attempts
           (run_id, stage, attempt, tenant_id, owner_user_id, visibility, fencing_token,
            worker_id, lease_started_at, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)`,
        [
          row.run_id,
          row.stage,
          row.attempt,
          input.scope.tenantId,
          input.scope.ownerUserId,
          input.scope.visibility,
          row.fencing_token,
          input.workerId,
          row.lease_expires_at,
        ],
      );
      return {
        jobId: row.job_id,
        runId: row.run_id,
        stage: row.stage,
        payload: row.payload,
        attempt: row.attempt,
        fencingToken: row.fencing_token,
        leaseExpiresAt: row.lease_expires_at,
        cancellationRequested: row.cancellation_requested,
      };
    });
  }

  async readPendingOutbox(input: {
    scope: CoreAccessScope;
    limit: number;
  }): Promise<CoreOutboxRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("Outbox limit must be an integer between 1 and 100.");
    }
    const result = await this.pool.query<{
      id: string;
      run_id: string;
      topic: string;
      payload: unknown;
      created_at: string;
    }>(
      `SELECT id, run_id, topic, payload, created_at::text FROM core_outbox
        WHERE tenant_id = $1 AND owner_user_id = $2 AND visibility = $3
          AND published_at IS NULL
        ORDER BY created_at, id LIMIT $4`,
      [...scopeValues(input.scope), input.limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      topic: row.topic,
      payload: row.payload,
      createdAt: row.created_at,
    }));
  }

  async markOutboxPublished(input: { scope: CoreAccessScope; id: string }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE core_outbox SET published_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4
          AND published_at IS NULL
        RETURNING id`,
      [input.id, ...scopeValues(input.scope)],
    );
    return changedOne(result);
  }

  async renewLease(input: {
    scope: CoreAccessScope;
    runId: string;
    stage: StageName;
    attempt: number;
    fencingToken: string;
    leaseSeconds: number;
  }): Promise<string> {
    const result = await this.pool.query<{ lease_expires_at: string }>(
      `UPDATE core_jobs
          SET lease_expires_at = NOW() + ($7 * INTERVAL '1 second'), updated_at = NOW()
        WHERE run_id = $1 AND stage = $2 AND attempt = $3 AND fencing_token = $4
          AND tenant_id = $5 AND owner_user_id = $6 AND visibility = $8
          AND status = 'leased' AND lease_expires_at > NOW() AND cancellation_requested = FALSE
        RETURNING lease_expires_at::text`,
      [
        input.runId,
        input.stage,
        input.attempt,
        input.fencingToken,
        input.scope.tenantId,
        input.scope.ownerUserId,
        input.leaseSeconds,
        input.scope.visibility,
      ],
    );
    const expiresAt = result.rows[0]?.lease_expires_at;
    if (!expiresAt) throw new StaleWorkerError("Lease is expired, canceled, or superseded.");
    return expiresAt;
  }

  async retry(input: {
    scope: CoreAccessScope;
    runId: string;
    stage: StageName;
    attempt: number;
    fencingToken: string;
    error: string;
    backoffMs: number;
  }): Promise<void> {
    if (!Number.isFinite(input.backoffMs) || input.backoffMs < 0) {
      throw new Error("backoffMs must be non-negative.");
    }
    await transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE core_jobs
          SET status = CASE WHEN attempt >= max_attempts THEN 'failed' ELSE 'retry' END,
              available_at = NOW() + ($8 * INTERVAL '1 millisecond'), last_error = $7,
              fencing_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE run_id = $1 AND stage = $2 AND attempt = $3 AND fencing_token = $4
          AND tenant_id = $5 AND owner_user_id = $6 AND visibility = $9
          AND status = 'leased' AND lease_expires_at > NOW()
        RETURNING job_id`,
        [
          input.runId,
          input.stage,
          input.attempt,
          input.fencingToken,
          input.scope.tenantId,
          input.scope.ownerUserId,
          input.error,
          Math.round(input.backoffMs),
          input.scope.visibility,
        ],
      );
      if (!changedOne(result)) throw new StaleWorkerError("Retry rejected for stale worker.");
      await client.query(
        `UPDATE core_stage_attempts SET finished_at = NOW(), outcome = 'failed'
          WHERE run_id = $1 AND stage = $2 AND attempt = $3 AND fencing_token = $4
            AND tenant_id = $5 AND owner_user_id = $6 AND visibility = $7`,
        [input.runId, input.stage, input.attempt, input.fencingToken, ...scopeValues(input.scope)],
      );
    });
  }

  async requestCancellation(input: {
    scope: CoreAccessScope;
    runId: string;
    reason: Exclude<RunContext["cancellation"]["reason"], null>;
  }): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const run = await client.query(
        `UPDATE core_runs
            SET cancellation = jsonb_build_object('requested', TRUE, 'requestedAt', NOW(), 'reason', $5::text),
                updated_at = NOW()
          WHERE run_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4
            AND finalized_at IS NULL
          RETURNING run_id`,
        [input.runId, ...scopeValues(input.scope), input.reason],
      );
      if (!changedOne(run)) return false;
      await client.query(
        `UPDATE core_jobs SET cancellation_requested = TRUE, updated_at = NOW()
          WHERE run_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4
            AND status NOT IN ('complete', 'failed', 'canceled')`,
        [input.runId, ...scopeValues(input.scope)],
      );
      return true;
    });
  }

  async acknowledgeCancellation(input: {
    scope: CoreAccessScope;
    runId: string;
    stage: StageName;
    attempt: number;
    fencingToken: string;
  }): Promise<void> {
    await transaction(this.pool, async (client) => {
      const canceled = await client.query(
        `UPDATE core_jobs
            SET status = 'canceled', completed_at = NOW(), updated_at = NOW(),
                fencing_token = NULL, lease_owner = NULL, lease_expires_at = NULL
          WHERE run_id = $1 AND stage = $2 AND attempt = $3 AND fencing_token = $4
            AND tenant_id = $5 AND owner_user_id = $6 AND visibility = $7
            AND status = 'leased' AND cancellation_requested = TRUE
          RETURNING job_id`,
        [input.runId, input.stage, input.attempt, input.fencingToken, ...scopeValues(input.scope)],
      );
      if (!changedOne(canceled)) {
        throw new StaleWorkerError("Cancellation acknowledgement rejected for stale worker.");
      }
      await client.query(
        `UPDATE core_stage_attempts SET finished_at = NOW(), outcome = 'canceled'
          WHERE run_id = $1 AND stage = $2 AND attempt = $3 AND fencing_token = $4
            AND tenant_id = $5 AND owner_user_id = $6 AND visibility = $7`,
        [input.runId, input.stage, input.attempt, input.fencingToken, ...scopeValues(input.scope)],
      );
      await client.query(
        `UPDATE core_runs SET status = 'canceled', finalized_at = NOW(), updated_at = NOW()
          WHERE run_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4`,
        [input.runId, ...scopeValues(input.scope)],
      );
    });
  }

  async checkpoint(input: {
    scope: CoreAccessScope;
    runId: string;
    stage: StageName;
    attempt: number;
    fencingToken: string;
    checkpointHash: string;
    payloadJson: string;
  }): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO core_stage_checkpoints
         (run_id, stage, tenant_id, owner_user_id, visibility, attempt, fencing_token,
          checkpoint_hash, payload_json)
       SELECT run_id, stage, tenant_id, owner_user_id, visibility, attempt, fencing_token, $8, $9
         FROM core_jobs
        WHERE run_id = $1 AND stage = $2 AND attempt = $3 AND fencing_token = $4
          AND tenant_id = $5 AND owner_user_id = $6 AND visibility = $7
          AND status = 'leased' AND lease_expires_at > NOW() AND cancellation_requested = FALSE
       ON CONFLICT (run_id, stage) DO UPDATE
         SET attempt = EXCLUDED.attempt, fencing_token = EXCLUDED.fencing_token,
             checkpoint_hash = EXCLUDED.checkpoint_hash, payload_json = EXCLUDED.payload_json,
             updated_at = NOW()
       RETURNING run_id`,
      [
        input.runId,
        input.stage,
        input.attempt,
        input.fencingToken,
        ...scopeValues(input.scope),
        input.checkpointHash,
        input.payloadJson,
      ],
    );
    if (!changedOne(result)) throw new StaleWorkerError("Checkpoint rejected for stale worker.");
  }

  async readCheckpoint(input: {
    scope: CoreAccessScope;
    runId: string;
    stage: StageName;
  }): Promise<{ checkpointHash: string; payloadJson: string } | null> {
    const result = await this.pool.query<{ checkpoint_hash: string; payload_json: string }>(
      `SELECT checkpoint_hash, payload_json FROM core_stage_checkpoints
        WHERE run_id = $1 AND stage = $2
          AND tenant_id = $3 AND owner_user_id = $4 AND visibility = $5`,
      [input.runId, input.stage, ...scopeValues(input.scope)],
    );
    const row = result.rows[0];
    return row ? { checkpointHash: row.checkpoint_hash, payloadJson: row.payload_json } : null;
  }

  async putSnapshot(input: { scope: CoreAccessScope; snapshot: DocumentSnapshot }): Promise<void> {
    const snapshot = documentSnapshotSchema.parse(input.snapshot);
    const snapshotJson = JSON.stringify(snapshot);
    const inserted = await this.pool.query<{ snapshot_id: string }>(
      `INSERT INTO core_snapshots
       (snapshot_id, tenant_id, owner_user_id, visibility, content_hash, raw_content_hash,
          normalized_text, snapshot, blob_status, blob_uri)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       ON CONFLICT (tenant_id, owner_user_id, visibility, snapshot_id) DO NOTHING
       RETURNING snapshot_id`,
      [
        snapshot.id,
        ...scopeValues(input.scope),
        snapshot.contentHash,
        snapshot.rawContentHash,
        snapshot.normalizedText,
        snapshotJson,
        snapshot.blobLocator.status,
        snapshot.blobLocator.uri,
      ],
    );
    if (inserted.rows[0]) return;
    const existing = await this.pool.query<{ content_hash: string; same_snapshot: boolean }>(
      `SELECT content_hash, snapshot = $5::jsonb AS same_snapshot FROM core_snapshots
        WHERE snapshot_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4`,
      [snapshot.id, ...scopeValues(input.scope), snapshotJson],
    );
    const row = existing.rows[0];
    if (!row) throw new CoreStorageAccessError("Snapshot is outside the caller scope.");
    if (row.content_hash !== snapshot.contentHash || !row.same_snapshot) {
      throw new CoreStorageConflictError("Snapshot IDs are immutable and cannot be overwritten.");
    }
  }

  async putSnapshotEmbedding(input: {
    scope: CoreAccessScope;
    snapshotId: string;
    model: string;
    dimensions: number;
    preprocessing: string;
    embedding: number[];
  }): Promise<void> {
    if (input.dimensions !== 1024 || input.embedding.length !== 1024) {
      throw new Error("Core v2 embeddings require the existing 1024-dimensional index.");
    }
    if (!input.embedding.every(Number.isFinite)) {
      throw new Error("Embedding contains a non-finite value.");
    }
    const vectorValue = `[${input.embedding.join(",")}]`;
    const result = await this.pool.query(
      `INSERT INTO core_snapshot_embeddings
         (snapshot_id, tenant_id, owner_user_id, visibility, model, dimensions,
          preprocessing, embedding)
       SELECT snapshot_id, tenant_id, owner_user_id, visibility, $5, $6, $7, $8::vector
         FROM core_snapshots
        WHERE snapshot_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4
       ON CONFLICT DO NOTHING
       RETURNING snapshot_id`,
      [
        input.snapshotId,
        ...scopeValues(input.scope),
        input.model,
        input.dimensions,
        input.preprocessing,
        vectorValue,
      ],
    );
    if (!changedOne(result)) {
      const existing = await this.pool.query<{ same_embedding: boolean }>(
        `SELECT embedding = $8::vector AS same_embedding FROM core_snapshot_embeddings
          WHERE snapshot_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4
            AND model = $5 AND dimensions = $6 AND preprocessing = $7`,
        [
          input.snapshotId,
          ...scopeValues(input.scope),
          input.model,
          input.dimensions,
          input.preprocessing,
          vectorValue,
        ],
      );
      if (!existing.rows[0]) {
        throw new CoreStorageAccessError("Embedding snapshot is outside the caller scope.");
      }
      if (!existing.rows[0].same_embedding) {
        throw new CoreStorageConflictError(
          "Embedding identity was reused with a different vector value.",
        );
      }
    }
  }

  async getSnapshot(input: {
    scope: CoreAccessScope;
    snapshotId: string;
  }): Promise<DocumentSnapshot | null> {
    const result = await this.pool.query<{ snapshot: DocumentSnapshot }>(
      `SELECT snapshot FROM core_snapshots
        WHERE snapshot_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4`,
      [input.snapshotId, ...scopeValues(input.scope)],
    );
    const snapshot = result.rows[0]?.snapshot;
    return snapshot ? documentSnapshotSchema.parse(snapshot) : null;
  }

  async getSnapshots(input: {
    scope: CoreAccessScope;
    snapshotIds: string[];
  }): Promise<DocumentSnapshot[]> {
    if (input.snapshotIds.length === 0) return [];
    const result = await this.pool.query<{ snapshot_id: string; snapshot: DocumentSnapshot }>(
      `SELECT snapshot_id, snapshot FROM core_snapshots
        WHERE snapshot_id = ANY($1::text[])
          AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4`,
      [input.snapshotIds, ...scopeValues(input.scope)],
    );
    const byId = new Map(
      result.rows.map((row) => [row.snapshot_id, documentSnapshotSchema.parse(row.snapshot)]),
    );
    return [...new Set(input.snapshotIds)].flatMap((id) => {
      const snapshot = byId.get(id);
      return snapshot ? [snapshot] : [];
    });
  }

  async finalize(input: {
    scope: CoreAccessScope;
    runId: string;
    fencingToken: string;
    reportHash: string;
    report: RunReport;
  }): Promise<void> {
    const report = runReportSchema.parse(input.report);
    if (report.runId !== input.runId || report.visibility !== input.scope.visibility) {
      throw new CoreStorageConflictError("Report identity does not match the run storage scope.");
    }
    await transaction(this.pool, async (client) => {
      const job = await client.query<{ attempt: number }>(
        `SELECT attempt FROM core_jobs
          WHERE run_id = $1 AND fencing_token = $2
            AND tenant_id = $3 AND owner_user_id = $4 AND visibility = $5
            AND status = 'leased' AND lease_expires_at > NOW()
            AND cancellation_requested = FALSE
          FOR UPDATE`,
        [input.runId, input.fencingToken, ...scopeValues(input.scope)],
      );
      const attempt = job.rows[0]?.attempt;
      if (attempt === undefined)
        throw new StaleWorkerError("Finalization rejected for stale worker.");

      const versionResult = await client.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM core_report_versions
          WHERE run_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4`,
        [input.runId, ...scopeValues(input.scope)],
      );
      const version = Number(versionResult.rows[0]?.version ?? 1);
      const diagnosticLabels = report.decisions.map(({ claimId, diagnosticLabel }) => ({
        claimId,
        label: diagnosticLabel,
      }));
      const publishedLabels = report.decisions.map(({ claimId, publishedLabel }) => ({
        claimId,
        label: publishedLabel,
      }));
      await client.query(
        `INSERT INTO core_report_versions
           (run_id, version, tenant_id, owner_user_id, visibility, report_hash,
            schema_version, contract_version, engine_version, diagnostic_labels,
            published_labels, factual_score, score_null_reasons, evidence_set_hash, report)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
                 $12, $13::jsonb, $14, $15::jsonb)`,
        [
          input.runId,
          version,
          ...scopeValues(input.scope),
          input.reportHash,
          report.schemaVersion,
          report.contractVersion,
          report.engineVersion,
          JSON.stringify(diagnosticLabels),
          JSON.stringify(publishedLabels),
          report.scorecard?.factualScore ?? null,
          JSON.stringify(report.scorecard?.nullReasons ?? []),
          report.evidenceSetHash,
          JSON.stringify(report),
        ],
      );
      for (const snapshot of report.snapshots) {
        const referenced = await client.query(
          `INSERT INTO core_report_snapshots
             (run_id, report_version, snapshot_id, tenant_id, owner_user_id, visibility)
           SELECT $1, $2, snapshot_id, tenant_id, owner_user_id, visibility
             FROM core_snapshots
            WHERE snapshot_id = $3 AND tenant_id = $4 AND owner_user_id = $5 AND visibility = $6
              AND content_hash = $7
           RETURNING snapshot_id`,
          [input.runId, version, snapshot.id, ...scopeValues(input.scope), snapshot.contentHash],
        );
        if (!changedOne(referenced)) {
          throw new CoreStorageConflictError(
            `Report references snapshot ${snapshot.id} that is not stored in the caller scope.`,
          );
        }
      }
      for (const claim of report.claims) {
        await client.query(
          `INSERT INTO core_report_claims
             (run_id, report_version, claim_id, tenant_id, owner_user_id, visibility, claim)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [input.runId, version, claim.id, ...scopeValues(input.scope), JSON.stringify(claim)],
        );
      }
      for (const assessment of report.assessments) {
        await client.query(
          `INSERT INTO core_evidence_assessments
             (run_id, report_version, assessment_id, claim_id, snapshot_id,
              tenant_id, owner_user_id, visibility, assessment)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            input.runId,
            version,
            assessment.id,
            assessment.claimId,
            assessment.snapshotId,
            ...scopeValues(input.scope),
            JSON.stringify(assessment),
          ],
        );
      }
      for (const graph of report.provenance) {
        for (const [edgeIndex, edge] of graph.edges.entries()) {
          await client.query(
            `INSERT INTO core_provenance_edges
               (run_id, report_version, claim_id, edge_index, tenant_id, owner_user_id,
                visibility, from_snapshot_id, to_snapshot_id, edge)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
            [
              input.runId,
              version,
              graph.claimId,
              edgeIndex,
              ...scopeValues(input.scope),
              edge.fromSnapshotId,
              edge.toSnapshotId,
              JSON.stringify(edge),
            ],
          );
        }
      }
      for (const decision of report.decisions) {
        await client.query(
          `INSERT INTO core_decisions
             (run_id, report_version, claim_id, tenant_id, owner_user_id, visibility,
              diagnostic_label, published_label, decision)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            input.runId,
            version,
            decision.claimId,
            ...scopeValues(input.scope),
            decision.diagnosticLabel,
            decision.publishedLabel,
            JSON.stringify(decision),
          ],
        );
      }
      const completed = await client.query(
        `UPDATE core_jobs
            SET status = 'complete', completed_at = NOW(), updated_at = NOW(),
                fencing_token = NULL, lease_owner = NULL, lease_expires_at = NULL
          WHERE run_id = $1 AND attempt = $2 AND fencing_token = $3
            AND tenant_id = $4 AND owner_user_id = $5 AND visibility = $6
            AND status = 'leased' AND lease_expires_at > NOW()
          RETURNING job_id`,
        [input.runId, attempt, input.fencingToken, ...scopeValues(input.scope)],
      );
      if (!changedOne(completed))
        throw new StaleWorkerError("Worker lost its lease during finalization.");
      await client.query(
        `UPDATE core_stage_attempts
            SET finished_at = NOW(), outcome = 'complete'
          WHERE run_id = $1 AND attempt = $2 AND fencing_token = $3
            AND tenant_id = $4 AND owner_user_id = $5 AND visibility = $6`,
        [input.runId, attempt, input.fencingToken, ...scopeValues(input.scope)],
      );
      await client.query(
        `UPDATE core_runs SET status = $2, finalized_at = NOW(), updated_at = NOW()
          WHERE run_id = $1 AND tenant_id = $3 AND owner_user_id = $4 AND visibility = $5`,
        [input.runId, report.status, ...scopeValues(input.scope)],
      );
    });
  }

  async getLatestReport(input: {
    scope: CoreAccessScope;
    runId: string;
  }): Promise<RunReport | null> {
    const result = await this.pool.query<{ report: RunReport }>(
      `SELECT report FROM core_report_versions
        WHERE run_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4
        ORDER BY version DESC LIMIT 1`,
      [input.runId, ...scopeValues(input.scope)],
    );
    const report = result.rows[0]?.report;
    return report ? runReportSchema.parse(report) : null;
  }

  async getReportVersion(input: {
    scope: CoreAccessScope;
    runId: string;
    version: number;
  }): Promise<RunReport | null> {
    const result = await this.pool.query<{ report: RunReport }>(
      `SELECT report FROM core_report_versions
        WHERE run_id = $1 AND version = $2
          AND tenant_id = $3 AND owner_user_id = $4 AND visibility = $5`,
      [input.runId, input.version, ...scopeValues(input.scope)],
    );
    const report = result.rows[0]?.report;
    return report ? runReportSchema.parse(report) : null;
  }
}
