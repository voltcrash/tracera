import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  completeRunReportExample,
  runContextExample,
  type RunContext,
  type RunReport,
} from "@repo/contracts/core-v2";
import { assertCoreStorageTestDatabase } from "@repo/environment";
import { afterAll, test } from "vite-plus/test";
import {
  CoreStorageConflictError,
  CoreStorageRepository,
  StaleWorkerError,
  type CoreAccessScope,
  type CorePool,
} from "../src/core/index.js";
import { createDatabasePool } from "../src/connection.js";

const databaseUrl = process.env.CORE_STORAGE_TEST_DATABASE_URL
  ? assertCoreStorageTestDatabase(process.env)
  : undefined;
const database = databaseUrl ? createDatabasePool(databaseUrl, process.env) : undefined;
const integrationTest = database ? test : test.skip;

afterAll(async () => {
  if (database) await database.pool.end();
});

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

function harness() {
  assert.ok(database);
  const pool = database.pool;
  return {
    pool,
    repository: new CoreStorageRepository(pool as unknown as CorePool),
  };
}

function uniqueContext(label: string, tenantId?: string, ownerUserId?: string) {
  const suffix = randomUUID();
  return fixtureContext(
    `${label}-${suffix}`,
    tenantId ?? `tenant-${suffix}`,
    ownerUserId ?? `owner-${suffix}`,
  );
}

integrationTest("duplicate enqueue is idempotent and emits one scoped outbox record", async () => {
  const { repository } = harness();
  const context = uniqueContext("duplicate");
  const scope = scopeOf(context);
  const input = {
    context,
    stage: "normalize_input" as const,
    payload: { fixture: true },
    maxAttempts: 3,
  };

  const first = await repository.enqueue(input);
  const duplicate = await repository.enqueue(input);
  assert.equal(first.created, true);
  assert.deepEqual(duplicate, { jobId: first.jobId, created: false });
  assert.equal((await repository.readPendingOutbox({ scope, limit: 10 })).length, 1);
  assert.equal(
    (
      await repository.readPendingOutbox({
        scope: { ...scope, tenantId: `other-${context.tenantId}` },
        limit: 10,
      })
    ).length,
    0,
  );
  const progress = await repository.getRunProgress({ scope, runId: context.runId });
  assert.equal(progress?.status, "queued");
  const globalLease = await repository.acquireNextLease({
    workerId: "durable-worker",
    leaseSeconds: 60,
  });
  assert.equal(globalLease?.runId, context.runId);
  assert.deepEqual(globalLease?.scope, scope);
  assert.equal(globalLease?.context.inputHash, context.inputHash);
});

integrationTest(
  "concurrent workers acquire distinct jobs and stale retry workers are fenced",
  async () => {
    const { repository } = harness();
    const firstContext = uniqueContext("worker-a");
    const secondContext = uniqueContext(
      "worker-b",
      firstContext.tenantId,
      firstContext.ownerUserId,
    );
    const scope = scopeOf(firstContext);
    await Promise.all([
      repository.enqueue({
        context: firstContext,
        stage: "normalize_input",
        payload: { fixture: "a" },
        maxAttempts: 3,
      }),
      repository.enqueue({
        context: secondContext,
        stage: "extract_claims",
        payload: { fixture: "b" },
        maxAttempts: 3,
      }),
    ]);

    const leases = await Promise.all([
      repository.acquireLease({ scope, workerId: "worker-1", leaseSeconds: 60 }),
      repository.acquireLease({ scope, workerId: "worker-2", leaseSeconds: 60 }),
    ]);
    assert.ok(leases[0]);
    assert.ok(leases[1]);
    assert.notEqual(leases[0].jobId, leases[1].jobId);

    const retried = leases[0];
    await repository.retry({
      scope,
      runId: retried.runId,
      stage: retried.stage,
      attempt: retried.attempt,
      fencingToken: retried.fencingToken,
      error: "synthetic worker crash",
      backoffMs: 0,
    });
    const replacement = await repository.acquireLease({
      scope,
      workerId: "replacement-worker",
      leaseSeconds: 60,
    });
    assert.ok(replacement);
    assert.equal(replacement.jobId, retried.jobId);
    assert.equal(replacement.attempt, retried.attempt + 1);
    assert.notEqual(replacement.fencingToken, retried.fencingToken);
    await assert.rejects(
      repository.checkpoint({
        scope,
        runId: retried.runId,
        stage: retried.stage,
        attempt: retried.attempt,
        fencingToken: retried.fencingToken,
        checkpointHash: firstContext.inputHash,
        payloadJson: "{}",
      }),
      StaleWorkerError,
    );
  },
);

integrationTest(
  "cancellation is tenant-scoped and requires the current fencing token",
  async () => {
    const { pool, repository } = harness();
    const context = uniqueContext("cancel");
    const scope = scopeOf(context);
    const otherScope = { ...scope, ownerUserId: `other-${scope.ownerUserId}` };
    const queuedContext = uniqueContext("cancel-queued");
    const queuedScope = scopeOf(queuedContext);
    await repository.enqueue({
      context: queuedContext,
      stage: "normalize_input",
      payload: { fixture: true },
      maxAttempts: 2,
    });
    assert.equal(
      await repository.requestCancellation({
        scope: queuedScope,
        runId: queuedContext.runId,
        reason: "user_request",
      }),
      true,
    );
    assert.equal(
      (await repository.getRunProgress({ scope: queuedScope, runId: queuedContext.runId }))?.status,
      "canceled",
    );
    await repository.enqueue({
      context,
      stage: "normalize_input",
      payload: { fixture: true },
      maxAttempts: 2,
    });
    const lease = await repository.acquireLease({
      scope,
      workerId: "cancel-worker",
      leaseSeconds: 60,
    });
    assert.ok(lease);
    assert.equal(
      await repository.requestCancellation({
        scope: otherScope,
        runId: context.runId,
        reason: "operator_request",
      }),
      false,
    );
    assert.equal(
      await repository.requestCancellation({
        scope,
        runId: context.runId,
        reason: "operator_request",
      }),
      true,
    );
    await assert.rejects(
      repository.checkpoint({
        scope,
        runId: context.runId,
        stage: lease.stage,
        attempt: lease.attempt,
        fencingToken: lease.fencingToken,
        checkpointHash: context.inputHash,
        payloadJson: "{}",
      }),
      StaleWorkerError,
    );
    await assert.rejects(
      repository.acknowledgeCancellation({
        scope,
        runId: context.runId,
        stage: lease.stage,
        attempt: lease.attempt,
        fencingToken: "stale-token",
      }),
      StaleWorkerError,
    );
    await repository.acknowledgeCancellation({
      scope,
      runId: context.runId,
      stage: lease.stage,
      attempt: lease.attempt,
      fencingToken: lease.fencingToken,
    });
    const state = await pool.query<{ run_status: string; job_status: string }>(
      `SELECT run.status AS run_status, job.status AS job_status
       FROM core_runs run JOIN core_jobs job USING (run_id)
      WHERE run.run_id = $1`,
      [context.runId],
    );
    assert.deepEqual(state.rows[0], { run_status: "canceled", job_status: "canceled" });
  },
);

integrationTest("a terminal retry finalizes the run and rejects later cancellation", async () => {
  const { pool, repository } = harness();
  const context = uniqueContext("terminal-retry");
  const scope = scopeOf(context);
  await repository.enqueue({
    context,
    stage: "normalize_input",
    payload: { fixture: true },
    maxAttempts: 1,
  });
  const lease = await repository.acquireLease({
    scope,
    workerId: "terminal-retry-worker",
    leaseSeconds: 60,
  });
  assert.ok(lease);

  assert.deepEqual(
    await repository.retry({
      scope,
      runId: context.runId,
      stage: lease.stage,
      attempt: lease.attempt,
      fencingToken: lease.fencingToken,
      error: "synthetic terminal failure",
      backoffMs: 0,
    }),
    { terminal: true },
  );
  assert.equal(
    (await repository.getRunProgress({ scope, runId: context.runId }))?.status,
    "failed",
  );
  const state = await pool.query<{ status: string; finalized: boolean }>(
    `SELECT status, finalized_at IS NOT NULL AS finalized FROM core_runs WHERE run_id = $1`,
    [context.runId],
  );
  assert.deepEqual(state.rows[0], { status: "failed", finalized: true });
  assert.equal(
    await repository.requestCancellation({ scope, runId: context.runId, reason: "user_request" }),
    false,
  );
});

integrationTest(
  "failed finalization rolls back and concurrent completion preserves report values",
  async () => {
    const { pool, repository } = harness();
    const context = uniqueContext("complete");
    const scope = scopeOf(context);
    const report = fixtureReport(context);
    await repository.enqueue({
      context,
      stage: "score_report",
      payload: { fixture: true },
      maxAttempts: 2,
    });
    const lease = await repository.acquireLease({
      scope,
      workerId: "completion-worker",
      leaseSeconds: 60,
    });
    assert.ok(lease);

    await assert.rejects(
      repository.finalize({
        scope,
        runId: context.runId,
        fencingToken: lease.fencingToken,
        reportHash: context.inputHash,
        report,
      }),
      CoreStorageConflictError,
    );
    const rolledBack = await pool.query<{ reports: string; status: string }>(
      `SELECT (SELECT COUNT(*)::text FROM core_report_versions WHERE run_id = $1) AS reports,
            (SELECT status FROM core_jobs WHERE run_id = $1) AS status`,
      [context.runId],
    );
    assert.deepEqual(rolledBack.rows[0], { reports: "0", status: "leased" });

    for (const snapshot of report.snapshots) {
      await repository.putSnapshot({ scope, snapshot });
    }
    const completions = await Promise.allSettled([
      repository.finalize({
        scope,
        runId: context.runId,
        fencingToken: lease.fencingToken,
        reportHash: context.inputHash,
        report,
      }),
      repository.finalize({
        scope,
        runId: context.runId,
        fencingToken: lease.fencingToken,
        reportHash: context.inputHash,
        report,
      }),
    ]);
    assert.equal(completions.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = completions.find(({ status }) => status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof StaleWorkerError);
    assert.deepEqual(await repository.getLatestReport({ scope, runId: context.runId }), report);

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
      [context.runId],
    );
    assert.equal(stored.rows[0]?.reports, "1");
    assert.equal(Number(stored.rows[0]?.factual_score), report.scorecard?.factualScore);
    assert.deepEqual(stored.rows[0]?.score_null_reasons, report.scorecard?.nullReasons);
    assert.deepEqual(
      stored.rows[0]?.diagnostic_labels,
      report.decisions.map(({ claimId, diagnosticLabel }) => ({
        claimId,
        label: diagnosticLabel,
      })),
    );
    assert.deepEqual(
      stored.rows[0]?.published_labels,
      report.decisions.map(({ claimId, publishedLabel }) => ({ claimId, label: publishedLabel })),
    );
  },
);

integrationTest("snapshots, checkpoints, and reports remain isolated across tenants", async () => {
  const { repository } = harness();
  const context = uniqueContext("isolation");
  const scope = scopeOf(context);
  const otherScope = {
    ...scope,
    tenantId: `other-${scope.tenantId}`,
    ownerUserId: `other-${scope.ownerUserId}`,
  };
  const report = fixtureReport(context);
  for (const snapshot of report.snapshots) {
    await repository.putSnapshot({ scope, snapshot });
  }
  assert.equal(
    await repository.getSnapshot({ scope: otherScope, snapshotId: report.snapshots[0]!.id }),
    null,
  );
  await repository.enqueue({
    context,
    stage: "score_report",
    payload: { fixture: true },
    maxAttempts: 2,
  });
  const lease = await repository.acquireLease({
    scope,
    workerId: "isolation-worker",
    leaseSeconds: 60,
  });
  assert.ok(lease);
  await repository.checkpoint({
    scope,
    runId: context.runId,
    stage: lease.stage,
    attempt: lease.attempt,
    fencingToken: lease.fencingToken,
    checkpointHash: context.inputHash,
    payloadJson: '{"synthetic":true}',
  });
  assert.equal(
    await repository.readCheckpoint({
      scope: otherScope,
      runId: context.runId,
      stage: lease.stage,
    }),
    null,
  );
  await repository.finalize({
    scope,
    runId: context.runId,
    fencingToken: lease.fencingToken,
    reportHash: context.inputHash,
    report,
  });
  assert.equal(await repository.getLatestReport({ scope: otherScope, runId: context.runId }), null);
  assert.equal(await repository.getRunProgress({ scope: otherScope, runId: context.runId }), null);
});
