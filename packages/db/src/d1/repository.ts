import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  documentSnapshotSchema,
  runContextSchema,
  type DocumentSnapshot,
  type RunContext,
  type StageName,
} from "@repo/contracts/analysis";
import type { AnalysisAccessScope } from "../analysis/repository.js";
import { D1PayloadStore, hashJson } from "./payloads.js";

export class AnalysisStorageConflictError extends Error {}
export class AnalysisStorageAccessError extends Error {}
export class StaleWorkerError extends Error {}

export interface D1RepositoryOptions {
  database: D1Database;
  bucket?: Pick<R2Bucket, "get" | "put">;
  now?: () => number;
}
export interface D1RunAttempt {
  runId: string;
  stage: StageName;
  attempt: number;
  fencingToken: string;
  version: number;
}
interface RunRow {
  run_id: string;
  tenant_id: string;
  owner_user_id: string;
  visibility: RunContext["visibility"];
  input_hash: string;
  context_hash: string;
  as_of_time: number;
  execution_mode: RunContext["executionMode"];
  status: "queued" | "running" | "complete" | "partial" | "unavailable" | "failed" | "canceled";
  stage: StageName;
  attempt: number;
  fencing_token: string | null;
  version: number;
  versions: string;
  budget: string;
  cancellation: string;
  audit_sink_id: string;
  provider_source: "platform" | "user" | null;
  provider: NonNullable<RunContext["provider"]>["provider"] | null;
  input_json: string | null;
  input_blob_uri: string | null;
  input_payload_hash: string | null;
  created_at: number;
  updated_at: number;
  finalized_at: number | null;
}
const scopeValues = (scope: AnalysisAccessScope) => [
  scope.tenantId,
  scope.ownerUserId,
  scope.visibility,
];
const owns = (row: RunRow, scope: AnalysisAccessScope) =>
  row.tenant_id === scope.tenantId &&
  row.owner_user_id === scope.ownerUserId &&
  row.visibility === scope.visibility;

export class D1AnalysisRepository {
  readonly payloads: D1PayloadStore;
  readonly database: D1Database;
  readonly now: () => number;
  constructor(options: D1RepositoryOptions) {
    this.database = options.database;
    this.payloads = new D1PayloadStore(options.bucket);
    this.now = options.now ?? Date.now;
  }

  async createRun(input: {
    context: RunContext;
    payload?: unknown;
  }): Promise<{ runId: string; created: boolean; version: number }> {
    const context = runContextSchema.parse(input.context);
    const payload = await this.payloads.encode(input.payload ?? null, "run-inputs");
    const contextHash = hashJson(context);
    const now = this.now();
    const [inserted, existing] = await this.database.batch<RunRow>([
      this.database
        .prepare(`INSERT INTO core_runs(run_id,tenant_id,owner_user_id,visibility,input_hash,context_hash,as_of_time,execution_mode,versions,budget,cancellation,audit_sink_id,provider_source,provider,input_json,input_blob_uri,input_payload_hash,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO NOTHING RETURNING *`)
        .bind(
          context.runId,
          context.tenantId,
          context.ownerUserId,
          context.visibility,
          context.inputHash,
          contextHash,
          Date.parse(context.asOfTime),
          context.executionMode,
          JSON.stringify(context.versions),
          JSON.stringify(context.budget),
          JSON.stringify(context.cancellation),
          context.auditSinkId,
          context.provider?.source ?? null,
          context.provider?.provider ?? null,
          payload.inline,
          payload.blobUri,
          payload.hash,
          now,
          now,
        ),
      this.database.prepare("SELECT * FROM core_runs WHERE run_id=?").bind(context.runId),
    ]);
    const row = existing!.results[0];
    if (!row || !owns(row, context))
      throw new AnalysisStorageAccessError("Run is outside the caller scope.");
    if (row.context_hash !== contextHash || row.input_payload_hash !== payload.hash)
      throw new AnalysisStorageConflictError(
        "Run identity was reused with different immutable input.",
      );
    return { runId: row.run_id, created: inserted!.results.length === 1, version: row.version };
  }

  private async run(scope: AnalysisAccessScope, runId: string): Promise<RunRow | null> {
    return this.database
      .prepare(
        "SELECT * FROM core_runs WHERE run_id=? AND tenant_id=? AND owner_user_id=? AND visibility=?",
      )
      .bind(runId, ...scopeValues(scope))
      .first<RunRow>();
  }

  async requestCancellation(input: {
    scope: AnalysisAccessScope;
    runId: string;
    reason: Exclude<RunContext["cancellation"]["reason"], null>;
  }): Promise<boolean> {
    const now = this.now();
    const cancellation = JSON.stringify({
      requested: true,
      requestedAt: new Date(now).toISOString(),
      reason: input.reason,
    });
    const result = await this.database
      .prepare(`UPDATE core_runs SET cancellation=?,status=CASE WHEN status='queued' THEN 'canceled' ELSE status END,finalized_at=CASE WHEN status='queued' THEN ? ELSE finalized_at END,updated_at=?,version=version+1
      WHERE run_id=? AND tenant_id=? AND owner_user_id=? AND visibility=? AND finalized_at IS NULL RETURNING run_id`)
      .bind(cancellation, now, now, input.runId, ...scopeValues(input.scope))
      .all();
    return result.results.length === 1;
  }

  async acknowledgeCancellation(input: {
    scope: AnalysisAccessScope;
    runId: string;
    attempt: number;
    fencingToken: string;
  }): Promise<void> {
    const now = this.now();
    const [changed] = await this.database.batch([
      this.database
        .prepare(
          `UPDATE core_runs SET status='canceled',finalized_at=?,updated_at=?,version=version+1 WHERE run_id=? AND tenant_id=? AND owner_user_id=? AND visibility=? AND attempt=? AND fencing_token=? AND finalized_at IS NULL AND json_extract(cancellation,'$.requested')=1 RETURNING run_id`,
        )
        .bind(
          now,
          now,
          input.runId,
          ...scopeValues(input.scope),
          input.attempt,
          input.fencingToken,
        ),
      this.database
        .prepare(
          `UPDATE core_stage_attempts SET finished_at=?,outcome='canceled' WHERE run_id=? AND tenant_id=? AND owner_user_id=? AND visibility=? AND fencing_token=? AND EXISTS(SELECT 1 FROM core_runs WHERE run_id=? AND status='canceled' AND fencing_token=?)`,
        )
        .bind(
          now,
          input.runId,
          ...scopeValues(input.scope),
          input.fencingToken,
          input.runId,
          input.fencingToken,
        ),
    ]);
    if (!changed!.results.length)
      throw new StaleWorkerError("Cancellation acknowledgement rejected for stale worker.");
  }

  async failRun(input: {
    scope: AnalysisAccessScope;
    runId: string;
    fencingToken: string | null;
    error: string;
  }): Promise<void> {
    const now = this.now();
    const [changed] = await this.database.batch([
      this.database
        .prepare(
          `UPDATE core_runs SET status='failed',last_error=?,finalized_at=?,updated_at=?,version=version+1 WHERE run_id=? AND tenant_id=? AND owner_user_id=? AND visibility=? AND fencing_token IS ? AND finalized_at IS NULL RETURNING run_id`,
        )
        .bind(
          input.error.slice(0, 2000),
          now,
          now,
          input.runId,
          ...scopeValues(input.scope),
          input.fencingToken,
        ),
      this.database
        .prepare(
          `UPDATE core_stage_attempts SET finished_at=?,outcome='failed' WHERE run_id=? AND tenant_id=? AND owner_user_id=? AND visibility=? AND fencing_token=? AND EXISTS(SELECT 1 FROM core_runs WHERE run_id=? AND status='failed' AND fencing_token IS ?)`,
        )
        .bind(
          now,
          input.runId,
          ...scopeValues(input.scope),
          input.fencingToken,
          input.runId,
          input.fencingToken,
        ),
    ]);
    if (!changed!.results.length)
      throw new StaleWorkerError("Failure rejected for finalized or superseded run.");
  }

  async getRunProgress(input: { scope: AnalysisAccessScope; runId: string }) {
    const [runs, checkpoints] = await this.database.batch<RunRow & { stage: StageName }>([
      this.database
        .prepare(
          "SELECT * FROM core_runs WHERE run_id=? AND tenant_id=? AND owner_user_id=? AND visibility=?",
        )
        .bind(input.runId, ...scopeValues(input.scope)),
      this.database
        .prepare(
          "SELECT stage FROM core_stage_checkpoints WHERE run_id=? AND tenant_id=? AND owner_user_id=? AND visibility=? ORDER BY updated_at,rowid",
        )
        .bind(input.runId, ...scopeValues(input.scope)),
    ]);
    const row = runs!.results[0];
    return row
      ? {
          runId: row.run_id,
          status: row.status,
          stage: row.stage,
          attempt: row.attempt,
          version: row.version,
          cancellationRequested: JSON.parse(row.cancellation).requested === true,
          completedStages: checkpoints!.results.map((row) => row.stage),
          updatedAt: new Date(row.updated_at).toISOString(),
        }
      : null;
  }

  async putSnapshot(input: {
    scope: AnalysisAccessScope;
    snapshot: DocumentSnapshot;
  }): Promise<void> {
    const snapshot = documentSnapshotSchema.parse(input.snapshot);
    const payload = await this.payloads.encode(
      snapshot,
      "snapshots",
      new TextEncoder().encode(snapshot.normalizedText).byteLength,
    );
    const result = await this.database
      .prepare(`INSERT INTO core_snapshots(snapshot_id,tenant_id,owner_user_id,visibility,content_hash,raw_content_hash,normalized_text,snapshot,snapshot_hash,snapshot_blob_uri,blob_status,blob_uri,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,owner_user_id,visibility,snapshot_id) DO UPDATE SET snapshot_id=excluded.snapshot_id
      WHERE core_snapshots.snapshot_hash=excluded.snapshot_hash RETURNING snapshot_id`)
      .bind(
        snapshot.id,
        ...scopeValues(input.scope),
        snapshot.contentHash,
        snapshot.rawContentHash,
        payload.inline ? snapshot.normalizedText : null,
        payload.inline,
        payload.hash,
        payload.blobUri,
        snapshot.blobLocator.status,
        snapshot.blobLocator.uri,
        this.now(),
      )
      .all();
    if (!result.results.length)
      throw new AnalysisStorageConflictError(
        "Snapshot IDs are immutable and cannot be overwritten.",
      );
  }

  async getSnapshot(input: {
    scope: AnalysisAccessScope;
    snapshotId: string;
  }): Promise<DocumentSnapshot | null> {
    const row = await this.database
      .prepare(
        "SELECT snapshot,snapshot_hash,snapshot_blob_uri FROM core_snapshots WHERE snapshot_id=? AND tenant_id=? AND owner_user_id=? AND visibility=?",
      )
      .bind(input.snapshotId, ...scopeValues(input.scope))
      .first<{
        snapshot: string | null;
        snapshot_hash: string;
        snapshot_blob_uri: string | null;
      }>();
    return row
      ? documentSnapshotSchema.parse(
          await this.payloads.read({
            inline: row.snapshot,
            blobUri: row.snapshot_blob_uri,
            hash: row.snapshot_hash,
          }),
        )
      : null;
  }

  async getSnapshots(input: {
    scope: AnalysisAccessScope;
    snapshotIds: readonly string[];
  }): Promise<DocumentSnapshot[]> {
    const output: DocumentSnapshot[] = [];
    const ids = [...new Set(input.snapshotIds)];
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const result = await this.database
        .prepare(
          "SELECT snapshot,snapshot_hash,snapshot_blob_uri FROM core_snapshots WHERE tenant_id=? AND owner_user_id=? AND visibility=? AND snapshot_id IN (SELECT value FROM json_each(?)) ORDER BY snapshot_id",
        )
        .bind(...scopeValues(input.scope), JSON.stringify(ids.slice(offset, offset + 1000)))
        .all<{
          snapshot: string | null;
          snapshot_hash: string;
          snapshot_blob_uri: string | null;
        }>();
      for (const row of result.results)
        output.push(
          documentSnapshotSchema.parse(
            await this.payloads.read({
              inline: row.snapshot,
              blobUri: row.snapshot_blob_uri,
              hash: row.snapshot_hash,
            }),
          ),
        );
    }
    return output;
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
    const payload = await this.payloads.encode(JSON.parse(input.payloadJson), "checkpoints");
    const now = this.now();
    const [changed] = await this.database.batch([
      this.database
        .prepare(`INSERT INTO core_stage_checkpoints(run_id,tenant_id,owner_user_id,visibility,stage,attempt,fencing_token,checkpoint_hash,payload_json,payload_blob_uri,created_at,updated_at)
        SELECT run_id,tenant_id,owner_user_id,visibility,?,attempt,fencing_token,?,?,?,?,? FROM core_runs
        WHERE run_id=? AND tenant_id=? AND owner_user_id=? AND visibility=? AND attempt=? AND fencing_token=? AND finalized_at IS NULL AND json_extract(cancellation,'$.requested')=0
        ON CONFLICT(run_id,stage) DO UPDATE SET attempt=excluded.attempt,fencing_token=excluded.fencing_token,checkpoint_hash=excluded.checkpoint_hash,payload_json=excluded.payload_json,payload_blob_uri=excluded.payload_blob_uri,updated_at=excluded.updated_at RETURNING run_id`)
        .bind(
          input.stage,
          input.checkpointHash,
          payload.inline,
          payload.blobUri,
          now,
          now,
          input.runId,
          ...scopeValues(input.scope),
          input.attempt,
          input.fencingToken,
        ),
      this.database
        .prepare(
          `UPDATE core_runs SET stage=?,version=version+1,updated_at=? WHERE run_id=? AND tenant_id=? AND owner_user_id=? AND visibility=? AND attempt=? AND fencing_token=? AND finalized_at IS NULL AND json_extract(cancellation,'$.requested')=0`,
        )
        .bind(
          input.stage,
          now,
          input.runId,
          ...scopeValues(input.scope),
          input.attempt,
          input.fencingToken,
        ),
    ]);
    if (!changed!.results.length)
      throw new StaleWorkerError("Checkpoint rejected for stale or canceled worker.");
  }

  async readCheckpoint(input: {
    scope: AnalysisAccessScope;
    runId: string;
    stage: StageName;
  }): Promise<{ checkpointHash: string; payloadJson: string } | null> {
    const row = await this.database
      .prepare(
        "SELECT checkpoint_hash,payload_json,payload_blob_uri FROM core_stage_checkpoints WHERE run_id=? AND stage=? AND tenant_id=? AND owner_user_id=? AND visibility=?",
      )
      .bind(input.runId, input.stage, ...scopeValues(input.scope))
      .first<{
        checkpoint_hash: string;
        payload_json: string | null;
        payload_blob_uri: string | null;
      }>();
    return row
      ? {
          checkpointHash: row.checkpoint_hash,
          payloadJson: JSON.stringify(
            await this.payloads.read({ inline: row.payload_json, blobUri: row.payload_blob_uri }),
          ),
        }
      : null;
  }

  async getRunContext(input: {
    scope: AnalysisAccessScope;
    runId: string;
  }): Promise<RunContext | null> {
    const row = await this.run(input.scope, input.runId);
    return row
      ? runContextSchema.parse({
          runId: row.run_id,
          tenantId: row.tenant_id,
          ownerUserId: row.owner_user_id,
          visibility: row.visibility,
          inputHash: row.input_hash,
          asOfTime: new Date(row.as_of_time).toISOString(),
          executionMode: row.execution_mode,
          versions: JSON.parse(row.versions),
          budget: JSON.parse(row.budget),
          cancellation: JSON.parse(row.cancellation),
          auditSinkId: row.audit_sink_id,
          ...(row.provider_source && row.provider
            ? { provider: { source: row.provider_source, provider: row.provider } }
            : {}),
        })
      : null;
  }

  async getRunInput(input: { scope: AnalysisAccessScope; runId: string }): Promise<unknown> {
    const row = await this.run(input.scope, input.runId);
    return row
      ? this.payloads.read({
          inline: row.input_json,
          blobUri: row.input_blob_uri,
          hash: row.input_payload_hash ?? undefined,
        })
      : null;
  }

  async beginAttempt(input: {
    scope: AnalysisAccessScope;
    runId: string;
    stage: StageName;
    expectedVersion: number;
  }): Promise<D1RunAttempt> {
    const token = crypto.randomUUID();
    const now = this.now();
    const [changed] = await this.database.batch<{ attempt: number; version: number }>([
      this.database
        .prepare(`UPDATE core_runs SET status='running',stage=?,attempt=attempt+1,fencing_token=?,version=version+1,updated_at=?
        WHERE run_id=? AND tenant_id=? AND owner_user_id=? AND visibility=? AND version=? AND finalized_at IS NULL AND json_extract(cancellation,'$.requested')=0 RETURNING attempt,version`)
        .bind(
          input.stage,
          token,
          now,
          input.runId,
          ...scopeValues(input.scope),
          input.expectedVersion,
        ),
      this.database
        .prepare(`INSERT INTO core_stage_attempts(run_id,tenant_id,owner_user_id,visibility,stage,attempt,fencing_token,started_at)
        SELECT run_id,tenant_id,owner_user_id,visibility,stage,attempt,fencing_token,? FROM core_runs
        WHERE run_id=? AND tenant_id=? AND owner_user_id=? AND visibility=? AND fencing_token=?`)
        .bind(now, input.runId, ...scopeValues(input.scope), token),
    ]);
    const row = changed!.results[0];
    if (!row)
      throw new StaleWorkerError("Attempt rejected for canceled, finalized or superseded run.");
    return {
      runId: input.runId,
      stage: input.stage,
      attempt: row.attempt,
      fencingToken: token,
      version: row.version,
    };
  }
}

export function createD1AnalysisRepository(options: D1RepositoryOptions): D1AnalysisRepository {
  return new D1AnalysisRepository(options);
}
