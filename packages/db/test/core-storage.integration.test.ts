import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import {
  completeRunReportExample,
  runContextExample,
  type RunContext,
  type RunReport,
} from "@repo/contracts/core-v2";
import { test } from "vite-plus/test";
import {
  CoreStorageRepository,
  StaleWorkerError,
  type CoreAccessScope,
  type CorePool,
} from "../src/core/index.js";

const databaseUrl = process.env.CORE_STORAGE_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;

function fixtureContext(runId: string, tenantId: string, ownerUserId: string): RunContext {
  return {
    ...structuredClone(runContextExample),
    runId,
    tenantId,
    ownerUserId,
    visibility: "private",
  };
}

function scopeOf(context: RunContext): CoreAccessScope {
  return {
    tenantId: context.tenantId,
    ownerUserId: context.ownerUserId,
    visibility: context.visibility,
  };
}

function fixtureReport(context: RunContext): RunReport {
  const report = structuredClone(completeRunReportExample);
  report.runId = context.runId;
  report.visibility = context.visibility;
  report.replayManifest.runId = context.runId;
  return report;
}

integrationTest(
  "core storage enforces idempotency, retries, fencing, atomic completion, and tenant scope",
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl });
    const repository = new CoreStorageRepository(pool as unknown as CorePool);
    const suffix = randomUUID();
    const context = fixtureContext(
      `fixture-retry-${suffix}`,
      `tenant-a-${suffix}`,
      `owner-a-${suffix}`,
    );
    const scope = scopeOf(context);
    const otherScope = {
      ...scope,
      tenantId: `tenant-b-${suffix}`,
      ownerUserId: `owner-b-${suffix}`,
    };
    const completionContext = fixtureContext(
      `fixture-complete-${suffix}`,
      context.tenantId,
      context.ownerUserId,
    );
    const completionScope = scopeOf(completionContext);
    const runIds = [context.runId, completionContext.runId];

    try {
      const first = await repository.enqueue({
        context,
        stage: "normalize_input",
        payload: { fixture: true },
        maxAttempts: 3,
      });
      const duplicate = await repository.enqueue({
        context,
        stage: "normalize_input",
        payload: { fixture: true },
        maxAttempts: 3,
      });
      assert.equal(first.created, true);
      assert.deepEqual(duplicate, { jobId: first.jobId, created: false });

      const firstLease = await repository.acquireLease({
        scope,
        workerId: "fixture-worker-1",
        leaseSeconds: 60,
      });
      assert.ok(firstLease);
      await repository.retry({
        scope,
        runId: context.runId,
        stage: firstLease.stage,
        attempt: firstLease.attempt,
        fencingToken: firstLease.fencingToken,
        error: "fixture crash",
        backoffMs: 0,
      });
      const retryLease = await repository.acquireLease({
        scope,
        workerId: "fixture-worker-2",
        leaseSeconds: 60,
      });
      assert.ok(retryLease);
      assert.equal(retryLease.attempt, firstLease.attempt + 1);
      assert.notEqual(retryLease.fencingToken, firstLease.fencingToken);
      await assert.rejects(
        repository.checkpoint({
          scope,
          runId: context.runId,
          stage: firstLease.stage,
          attempt: firstLease.attempt,
          fencingToken: firstLease.fencingToken,
          checkpointHash: context.inputHash,
          payloadJson: "{}",
        }),
        StaleWorkerError,
      );
      await repository.checkpoint({
        scope,
        runId: context.runId,
        stage: retryLease.stage,
        attempt: retryLease.attempt,
        fencingToken: retryLease.fencingToken,
        checkpointHash: context.inputHash,
        payloadJson: "{}",
      });
      assert.equal(
        await repository.readCheckpoint({
          scope: otherScope,
          runId: context.runId,
          stage: retryLease.stage,
        }),
        null,
      );
      assert.equal(
        await repository.requestCancellation({
          scope,
          runId: context.runId,
          reason: "operator_request",
        }),
        true,
      );
      await repository.acknowledgeCancellation({
        scope,
        runId: context.runId,
        stage: retryLease.stage,
        attempt: retryLease.attempt,
        fencingToken: retryLease.fencingToken,
      });

      const report = fixtureReport(completionContext);
      for (const snapshot of report.snapshots) {
        await repository.putSnapshot({ scope: completionScope, snapshot });
      }
      assert.equal(
        await repository.getSnapshot({
          scope: otherScope,
          snapshotId: report.snapshots[0]?.id ?? "missing",
        }),
        null,
      );
      await repository.enqueue({
        context: completionContext,
        stage: "score_report",
        payload: { fixture: true },
        maxAttempts: 2,
      });
      const completionLease = await repository.acquireLease({
        scope: completionScope,
        workerId: "fixture-completer",
        leaseSeconds: 60,
      });
      assert.ok(completionLease);
      await repository.finalize({
        scope: completionScope,
        runId: completionContext.runId,
        fencingToken: completionLease.fencingToken,
        reportHash: completionContext.inputHash,
        report,
      });
      assert.deepEqual(
        await repository.getLatestReport({
          scope: completionScope,
          runId: completionContext.runId,
        }),
        report,
      );
      assert.equal(
        await repository.getLatestReport({ scope: otherScope, runId: completionContext.runId }),
        null,
      );
      await assert.rejects(
        repository.finalize({
          scope: completionScope,
          runId: completionContext.runId,
          fencingToken: completionLease.fencingToken,
          reportHash: completionContext.inputHash,
          report,
        }),
        StaleWorkerError,
      );
      const stored = await pool.query<{
        reports: string;
        factual_score: string | null;
        score_null_reasons: unknown;
        diagnostic_labels: unknown;
        published_labels: unknown;
      }>(
        `SELECT COUNT(*) OVER()::text AS reports, factual_score::text,
                score_null_reasons, diagnostic_labels, published_labels
           FROM core_report_versions WHERE run_id = $1 LIMIT 1`,
        [completionContext.runId],
      );
      assert.equal(stored.rows[0]?.reports, "1");
      assert.equal(Number(stored.rows[0]?.factual_score), report.scorecard?.factualScore);
      assert.deepEqual(stored.rows[0]?.score_null_reasons, report.scorecard?.nullReasons);
      assert.equal(Array.isArray(stored.rows[0]?.diagnostic_labels), true);
      assert.equal(Array.isArray(stored.rows[0]?.published_labels), true);
    } finally {
      await pool.query("DELETE FROM core_decisions WHERE run_id = ANY($1::text[])", [runIds]);
      await pool.query("DELETE FROM core_provenance_edges WHERE run_id = ANY($1::text[])", [
        runIds,
      ]);
      await pool.query("DELETE FROM core_evidence_assessments WHERE run_id = ANY($1::text[])", [
        runIds,
      ]);
      await pool.query("DELETE FROM core_report_claims WHERE run_id = ANY($1::text[])", [runIds]);
      await pool.query("DELETE FROM core_report_snapshots WHERE run_id = ANY($1::text[])", [
        runIds,
      ]);
      await pool.query("DELETE FROM core_report_versions WHERE run_id = ANY($1::text[])", [runIds]);
      await pool.query("DELETE FROM core_snapshots WHERE tenant_id = $1 AND owner_user_id = $2", [
        context.tenantId,
        context.ownerUserId,
      ]);
      await pool.query("DELETE FROM core_runs WHERE run_id = ANY($1::text[])", [runIds]);
      await pool.end();
    }
  },
  30_000,
);
