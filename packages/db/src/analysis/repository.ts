import { randomUUID } from "node:crypto";
import {
  documentSnapshotSchema,
  runContextSchema,
  runReportSchema,
  type DocumentSnapshot,
  type RunContext,
  type RunReport,
  type StageName,
} from "@repo/contracts/analysis";

export type AnalysisVisibility = RunContext["visibility"];

export interface AnalysisAccessScope {
  tenantId: string;
  ownerUserId: string;
  visibility: AnalysisVisibility;
}

export interface AnalysisQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}

export interface AnalysisQueryable {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<AnalysisQueryResult<Row>>;
}

export interface AnalysisTransactionClient extends AnalysisQueryable {
  release(destroy?: boolean): void;
}

export interface AnalysisPool extends AnalysisQueryable {
  connect(): Promise<AnalysisTransactionClient>;
}

export class AnalysisStorageConflictError extends Error {}
export class AnalysisStorageAccessError extends Error {}
export class StaleWorkerError extends Error {}

export interface AnalysisLease {
  jobId: string;
  runId: string;
  stage: StageName;
  payload: unknown;
  attempt: number;
  fencingToken: string;
  leaseExpiresAt: string;
  cancellationRequested: boolean;
}

export interface AnalysisScopedLease extends AnalysisLease {
  scope: AnalysisAccessScope;
  context: RunContext;
}

export interface AnalysisRunProgress {
  runId: string;
  status:
    | "queued"
    | "leased"
    | "retry"
    | "complete"
    | "partial"
    | "unavailable"
    | "failed"
    | "canceled";
  stage: StageName;
  attempt: number;
  cancellationRequested: boolean;
  leaseExpiresAt: string | null;
  completedStages: StageName[];
  updatedAt: string;
}

export interface AnalysisRunSummary {
  runId: string;
  status: RunReport["status"] | "queued" | "leased" | "retry" | "canceled";
  createdAt: string;
  report: RunReport | null;
}

export interface AnalysisOutboxRecord {
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

const scopeValues = (scope: AnalysisAccessScope) => [
  scope.tenantId,
  scope.ownerUserId,
  scope.visibility,
];

const changedOne = (result: AnalysisQueryResult) =>
  result.rowCount === 1 || (result.rowCount === undefined && result.rows.length === 1);

async function transaction<Value>(
  pool: AnalysisPool,
  operation: (client: AnalysisTransactionClient) => Promise<Value>,
) {
  const client = await pool.connect();
  let open = false;
  let destroy = false;
  try {
    await client.query("BEGIN");
    open = true;
    const value = await operation(client);
    try {
      await client.query("COMMIT");
    } catch (error) {
      destroy = true;
      throw error;
    }
    open = false;
    return value;
  } catch (error) {
    if (open) {
      try {
        await client.query("ROLLBACK");
        open = false;
      } catch {
        destroy = true;
      }
    } else {
      destroy = true;
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}

export class AnalysisRepository {
  constructor(private readonly pool: AnalysisPool) {}

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
      if (!ownedRun) throw new AnalysisStorageAccessError("Run is outside the caller scope.");
      if (
        ownedRun.input_hash !== scope.inputHash ||
        ownedRun.execution_mode !== scope.executionMode ||
        !ownedRun.same_versions ||
        !ownedRun.same_budget
      ) {
        throw new AnalysisStorageConflictError(
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
          throw new AnalysisStorageConflictError(
            "Duplicate enqueue key was reused with a different payload or retry policy.",
          );
        }
      }
      await client.query(
        `INSERT INTO core_outbox
           (id, tenant_id, owner_user_id, visibility, run_id, topic, deduplication_key, payload)
         VALUES ($1, $2, $3, $4, $5, 'analysis.job.queued', $6, $7::jsonb)
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
    scope: AnalysisAccessScope;
    workerId: string;
    leaseSeconds: number;
    runId?: string;
  }): Promise<AnalysisLease | null> {
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1) {
      throw new Error("leaseSeconds must be a positive integer.");
    }
    return transaction(this.pool, async (client) => {
      const candidate = await client.query<{ job_id: string }>(
        `SELECT job_id FROM core_jobs
          WHERE tenant_id = $1 AND owner_user_id = $2 AND visibility = $3
            AND ($4::text IS NULL OR run_id = $4)
            AND cancellation_requested = FALSE
            AND attempt < max_attempts
            AND available_at <= NOW()
            AND (status IN ('queued', 'retry') OR (status = 'leased' AND lease_expires_at <= NOW()))
          ORDER BY available_at, created_at, job_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [...scopeValues(input.scope), input.runId ?? null],
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
      if (!row) throw new AnalysisStorageAccessError("Lease candidate left the caller scope.");
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

  async acquireNextLease(input: {
    workerId: string;
    leaseSeconds: number;
  }): Promise<AnalysisScopedLease | null> {
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1) {
      throw new Error("leaseSeconds must be a positive integer.");
    }
    return transaction(this.pool, async (client) => {
      // Abandoned leases would otherwise stay "leased" forever once no attempt or no
      // cancellation-free path remains, so they are resolved terminally before selection.
      const abandoned = await client.query<{
        job_id: string;
        run_id: string;
        stage: StageName;
        attempt: number;
        tenant_id: string;
        owner_user_id: string;
        visibility: AnalysisVisibility;
        outcome: "canceled" | "failed";
      }>(
        `SELECT job.job_id, job.run_id, job.stage, job.attempt, job.tenant_id,
                job.owner_user_id, job.visibility,
                CASE WHEN job.cancellation_requested THEN 'canceled' ELSE 'failed' END AS outcome
           FROM core_runs AS run
           JOIN core_jobs AS job
             ON job.run_id = run.run_id
            AND job.tenant_id = run.tenant_id
            AND job.owner_user_id = run.owner_user_id
            AND job.visibility = run.visibility
          WHERE run.finalized_at IS NULL
            AND job.status = 'leased' AND job.lease_expires_at <= NOW()
            AND (job.cancellation_requested = TRUE OR job.attempt >= job.max_attempts)
          ORDER BY job.updated_at, job.job_id
          FOR UPDATE OF run SKIP LOCKED`,
      );
      for (const row of abandoned.rows) {
        const settled = await client.query(
          `UPDATE core_jobs AS job
              SET status = $2, completed_at = NOW(), updated_at = NOW(),
                  last_error = CASE WHEN $2 = 'canceled' THEN job.last_error
                                    ELSE 'Lease expired on the final attempt.' END,
                  fencing_token = NULL, lease_owner = NULL, lease_expires_at = NULL
            WHERE job.job_id = $1 AND job.status = 'leased' AND job.lease_expires_at <= NOW()
              AND (job.cancellation_requested = TRUE OR job.attempt >= job.max_attempts)
            RETURNING job_id`,
          [row.job_id, row.outcome],
        );
        if (!changedOne(settled)) continue;
        await client.query(
          `UPDATE core_stage_attempts SET finished_at = NOW(), outcome = $4
            WHERE run_id = $1 AND stage = $2 AND attempt = $3 AND finished_at IS NULL
              AND tenant_id = $5 AND owner_user_id = $6 AND visibility = $7`,
          [
            row.run_id,
            row.stage,
            row.attempt,
            row.outcome,
            row.tenant_id,
            row.owner_user_id,
            row.visibility,
          ],
        );
        await client.query(
          `UPDATE core_runs SET status = $2, finalized_at = NOW(), updated_at = NOW()
            WHERE run_id = $1 AND tenant_id = $3 AND owner_user_id = $4 AND visibility = $5
              AND finalized_at IS NULL`,
          [row.run_id, row.outcome, row.tenant_id, row.owner_user_id, row.visibility],
        );
      }
      const candidate = await client.query<{ job_id: string }>(
        `SELECT job_id FROM core_jobs
          WHERE cancellation_requested = FALSE
            AND attempt < max_attempts
            AND available_at <= NOW()
            AND (status IN ('queued', 'retry') OR (status = 'leased' AND lease_expires_at <= NOW()))
          ORDER BY available_at, created_at, job_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
      );
      const jobId = candidate.rows[0]?.job_id;
      if (!jobId) return null;
      await client.query(
        `UPDATE core_stage_attempts AS attempt
            SET finished_at = NOW(), outcome = 'failed'
           FROM core_jobs AS job
          WHERE job.job_id = $1 AND job.status = 'leased' AND job.lease_expires_at <= NOW()
            AND attempt.run_id = job.run_id AND attempt.stage = job.stage
            AND attempt.attempt = job.attempt AND attempt.finished_at IS NULL`,
        [jobId],
      );
      const fencingToken = randomUUID();
      const leased = await client.query<
        JobRow & {
          tenant_id: string;
          owner_user_id: string;
          visibility: AnalysisVisibility;
          input_hash: string;
          as_of_time: string;
          execution_mode: RunContext["executionMode"];
          versions: RunContext["versions"];
          budget: RunContext["budget"];
          cancellation: RunContext["cancellation"];
          audit_sink_id: string;
        }
      >(
        `UPDATE core_jobs AS job
            SET status = 'leased', attempt = job.attempt + 1, fencing_token = $2,
                lease_owner = $3, lease_expires_at = NOW() + ($4 * INTERVAL '1 second'),
                updated_at = NOW()
           FROM core_runs AS run
          WHERE job.job_id = $1 AND run.run_id = job.run_id
          RETURNING job.job_id, job.run_id, job.stage, job.payload, job.attempt,
                    job.fencing_token, job.lease_expires_at::text, job.cancellation_requested,
                    job.tenant_id, job.owner_user_id, job.visibility, run.input_hash,
                    run.as_of_time::text, run.execution_mode, run.versions, run.budget,
                    run.cancellation, run.audit_sink_id`,
        [jobId, fencingToken, input.workerId, input.leaseSeconds],
      );
      const row = leased.rows[0];
      if (!row) throw new AnalysisStorageAccessError("Lease candidate disappeared.");
      await client.query(
        `INSERT INTO core_stage_attempts
           (run_id, stage, attempt, tenant_id, owner_user_id, visibility, fencing_token,
            worker_id, lease_started_at, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)`,
        [
          row.run_id,
          row.stage,
          row.attempt,
          row.tenant_id,
          row.owner_user_id,
          row.visibility,
          row.fencing_token,
          input.workerId,
          row.lease_expires_at,
        ],
      );
      const scope = {
        tenantId: row.tenant_id,
        ownerUserId: row.owner_user_id,
        visibility: row.visibility,
      };
      const context = runContextSchema.parse({
        runId: row.run_id,
        ...scope,
        inputHash: row.input_hash,
        asOfTime: new Date(row.as_of_time).toISOString(),
        versions: row.versions,
        executionMode: row.execution_mode,
        budget: row.budget,
        cancellation: row.cancellation,
        auditSinkId: row.audit_sink_id,
      });
      return {
        scope,
        context,
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

  async getRunProgress(input: {
    scope: AnalysisAccessScope;
    runId: string;
  }): Promise<AnalysisRunProgress | null> {
    const result = await this.pool.query<{
      run_id: string;
      status: AnalysisRunProgress["status"];
      stage: StageName;
      attempt: number;
      cancellation_requested: boolean;
      lease_expires_at: string | null;
      updated_at: string;
      completed_stages: StageName[];
    }>(
      `SELECT job.run_id,
              CASE WHEN job.status = 'complete' THEN run.status ELSE job.status END AS status,
              job.stage, job.attempt, job.cancellation_requested,
              job.lease_expires_at::text, job.updated_at::text,
              COALESCE(array_agg(checkpoint.stage ORDER BY checkpoint.updated_at)
                FILTER (WHERE checkpoint.stage IS NOT NULL), ARRAY[]::text[]) AS completed_stages
         FROM core_jobs AS job
         JOIN core_runs AS run
           ON run.run_id = job.run_id
          AND run.tenant_id = job.tenant_id
          AND run.owner_user_id = job.owner_user_id
          AND run.visibility = job.visibility
         LEFT JOIN core_stage_checkpoints AS checkpoint
           ON checkpoint.run_id = job.run_id
          AND checkpoint.tenant_id = job.tenant_id
          AND checkpoint.owner_user_id = job.owner_user_id
          AND checkpoint.visibility = job.visibility
        WHERE job.run_id = $1 AND job.tenant_id = $2 AND job.owner_user_id = $3
          AND job.visibility = $4
        GROUP BY job.run_id, run.status, job.status, job.stage, job.attempt,
                 job.cancellation_requested,
                 job.lease_expires_at, job.updated_at`,
      [input.runId, ...scopeValues(input.scope)],
    );
    const row = result.rows[0];
    return row
      ? {
          runId: row.run_id,
          status: row.status,
          stage: row.stage,
          attempt: row.attempt,
          cancellationRequested: row.cancellation_requested,
          leaseExpiresAt: row.lease_expires_at,
          completedStages: row.completed_stages,
          updatedAt: row.updated_at,
        }
      : null;
  }

  async listRuns(input: {
    scope: AnalysisAccessScope;
    limit: number;
  }): Promise<AnalysisRunSummary[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("Run history limit must be an integer between 1 and 100.");
    }
    const result = await this.pool.query<{
      run_id: string;
      status: AnalysisRunSummary["status"];
      created_at: string;
      report: RunReport | null;
    }>(
      `SELECT run.run_id,
              CASE
                WHEN latest_job.status IS NULL OR latest_job.status = 'complete' THEN run.status
                ELSE latest_job.status
              END AS status,
              run.created_at::text, latest.report
         FROM core_runs AS run
         LEFT JOIN LATERAL (
           SELECT report.report
             FROM core_report_versions AS report
            WHERE report.run_id = run.run_id
              AND report.tenant_id = run.tenant_id
              AND report.owner_user_id = run.owner_user_id
              AND report.visibility = run.visibility
            ORDER BY report.version DESC
            LIMIT 1
         ) AS latest ON TRUE
         LEFT JOIN LATERAL (
           SELECT job.status
             FROM core_jobs AS job
            WHERE job.run_id = run.run_id
              AND job.tenant_id = run.tenant_id
              AND job.owner_user_id = run.owner_user_id
              AND job.visibility = run.visibility
            ORDER BY job.updated_at DESC, job.created_at DESC
            LIMIT 1
         ) AS latest_job ON TRUE
        WHERE run.tenant_id = $1 AND run.owner_user_id = $2 AND run.visibility = $3
        ORDER BY run.created_at DESC, run.run_id DESC
        LIMIT $4`,
      [...scopeValues(input.scope), input.limit],
    );
    return result.rows.map((row) => ({
      runId: row.run_id,
      status: row.status,
      createdAt: row.created_at,
      report: row.report ? runReportSchema.parse(row.report) : null,
    }));
  }

  async findLatestCompletedReport(input: {
    scope: AnalysisAccessScope;
    inputHash: string;
  }): Promise<RunReport | null> {
    const result = await this.pool.query<{ report: RunReport }>(
      `SELECT report.report
         FROM core_report_versions AS report
         JOIN core_runs AS run ON run.run_id = report.run_id
        WHERE run.input_hash = $1 AND report.tenant_id = $2 AND report.owner_user_id = $3
          AND report.visibility = $4 AND run.status = 'complete'
        ORDER BY report.created_at DESC LIMIT 1`,
      [input.inputHash, ...scopeValues(input.scope)],
    );
    const report = result.rows[0]?.report;
    return report ? runReportSchema.parse(report) : null;
  }

  async readPendingOutbox(input: {
    scope: AnalysisAccessScope;
    limit: number;
  }): Promise<AnalysisOutboxRecord[]> {
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

  async markOutboxPublished(input: { scope: AnalysisAccessScope; id: string }): Promise<boolean> {
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
    scope: AnalysisAccessScope;
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
    scope: AnalysisAccessScope;
    runId: string;
    stage: StageName;
    attempt: number;
    fencingToken: string;
    error: string;
    backoffMs: number;
  }): Promise<{ terminal: boolean }> {
    if (!Number.isFinite(input.backoffMs) || input.backoffMs < 0) {
      throw new Error("backoffMs must be non-negative.");
    }
    return transaction(this.pool, async (client) => {
      const run = await client.query<{ run_id: string }>(
        `SELECT run_id
           FROM core_runs
          WHERE run_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4
            AND finalized_at IS NULL
          FOR UPDATE`,
        [input.runId, ...scopeValues(input.scope)],
      );
      if (!changedOne(run)) throw new StaleWorkerError("Retry rejected for finalized run.");
      const result = await client.query<{ status: "retry" | "failed" }>(
        `UPDATE core_jobs
          SET status = CASE WHEN attempt >= max_attempts THEN 'failed' ELSE 'retry' END,
              completed_at = CASE WHEN attempt >= max_attempts THEN NOW() ELSE completed_at END,
              available_at = NOW() + ($8 * INTERVAL '1 millisecond'), last_error = $7,
              fencing_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE run_id = $1 AND stage = $2 AND attempt = $3 AND fencing_token = $4
          AND tenant_id = $5 AND owner_user_id = $6 AND visibility = $9
          AND status = 'leased' AND lease_expires_at > NOW()
        RETURNING status`,
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
      const terminal = result.rows[0]?.status === "failed";
      if (terminal) {
        await client.query(
          `UPDATE core_runs
              SET status = 'failed', finalized_at = NOW(), updated_at = NOW()
            WHERE run_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4
              AND finalized_at IS NULL`,
          [input.runId, ...scopeValues(input.scope)],
        );
      }
      return { terminal };
    });
  }

  async requestCancellation(input: {
    scope: AnalysisAccessScope;
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
      await client.query(
        `UPDATE core_jobs
            SET status = 'canceled', completed_at = NOW(), updated_at = NOW()
          WHERE run_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4
            AND status IN ('queued', 'retry')`,
        [input.runId, ...scopeValues(input.scope)],
      );
      const active = await client.query<{ active: string }>(
        `SELECT COUNT(*)::text AS active FROM core_jobs
          WHERE run_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4
            AND status = 'leased'`,
        [input.runId, ...scopeValues(input.scope)],
      );
      if (Number(active.rows[0]?.active ?? 0) === 0) {
        await client.query(
          `UPDATE core_runs
              SET status = 'canceled', finalized_at = NOW(), updated_at = NOW()
            WHERE run_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4`,
          [input.runId, ...scopeValues(input.scope)],
        );
      }
      return true;
    });
  }

  async acknowledgeCancellation(input: {
    scope: AnalysisAccessScope;
    runId: string;
    stage: StageName;
    attempt: number;
    fencingToken: string;
  }): Promise<void> {
    await transaction(this.pool, async (client) => {
      const run = await client.query<{ run_id: string }>(
        `SELECT run_id
           FROM core_runs
          WHERE run_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4
            AND finalized_at IS NULL
          FOR UPDATE`,
        [input.runId, ...scopeValues(input.scope)],
      );
      if (!changedOne(run))
        throw new StaleWorkerError("Cancellation acknowledgement rejected for finalized run.");
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
    scope: AnalysisAccessScope;
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
    scope: AnalysisAccessScope;
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

  async putSnapshot(input: {
    scope: AnalysisAccessScope;
    snapshot: DocumentSnapshot;
  }): Promise<void> {
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
    if (!row) throw new AnalysisStorageAccessError("Snapshot is outside the caller scope.");
    if (row.content_hash !== snapshot.contentHash || !row.same_snapshot) {
      throw new AnalysisStorageConflictError(
        "Snapshot IDs are immutable and cannot be overwritten.",
      );
    }
  }

  async putSnapshotEmbedding(input: {
    scope: AnalysisAccessScope;
    snapshotId: string;
    model: string;
    dimensions: number;
    preprocessing: string;
    embedding: number[];
  }): Promise<void> {
    if (input.dimensions !== 1024 || input.embedding.length !== 1024) {
      throw new Error("Analysis embeddings require the existing 1024-dimensional index.");
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
        throw new AnalysisStorageAccessError("Embedding snapshot is outside the caller scope.");
      }
      if (!existing.rows[0].same_embedding) {
        throw new AnalysisStorageConflictError(
          "Embedding identity was reused with a different vector value.",
        );
      }
    }
  }

  async getSnapshot(input: {
    scope: AnalysisAccessScope;
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
    scope: AnalysisAccessScope;
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
    scope: AnalysisAccessScope;
    runId: string;
    fencingToken: string;
    reportHash: string;
    report: RunReport;
  }): Promise<void> {
    const report = runReportSchema.parse(input.report);
    if (report.runId !== input.runId || report.visibility !== input.scope.visibility) {
      throw new AnalysisStorageConflictError(
        "Report identity does not match the run storage scope.",
      );
    }
    await transaction(this.pool, async (client) => {
      const run = await client.query<{ run_id: string }>(
        `SELECT run_id
           FROM core_runs
          WHERE run_id = $1 AND tenant_id = $2 AND owner_user_id = $3 AND visibility = $4
            AND finalized_at IS NULL
          FOR UPDATE`,
        [input.runId, ...scopeValues(input.scope)],
      );
      if (!changedOne(run)) throw new StaleWorkerError("Finalization rejected for finalized run.");
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
          throw new AnalysisStorageConflictError(
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
    scope: AnalysisAccessScope;
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
    scope: AnalysisAccessScope;
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
