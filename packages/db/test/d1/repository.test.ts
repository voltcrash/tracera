import {
  completeRunReportExample,
  runContextExample,
  type RunContext,
} from "@repo/contracts/analysis";
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import {
  createD1AnalysisRepository,
  AnalysisStorageConflictError,
  StaleWorkerError,
} from "../../src/repository.js";
import { createTestRuntime } from "./runtime.js";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  runtime = await createTestRuntime();
});
afterAll(async () => {
  await runtime?.dispose();
});
const context = (id: string): RunContext => ({
  ...structuredClone(runContextExample),
  runId: id,
  tenantId: "tenant",
  ownerUserId: "owner",
  visibility: "private",
});
const scope = { tenantId: "tenant", ownerUserId: "owner", visibility: "private" as const };
const repo = () =>
  createD1AnalysisRepository({
    database: runtime.db,
    bucket: runtime.bucket,
    now: () => Date.parse("2026-10-12T00:00:00Z"),
  });

test("a stopped Workflow can acknowledge only a requested cancellation and fences late writes", async () => {
  const repository = repo();
  const ctx = context("stopped-workflow");
  await repository.createRun({ context: ctx });
  expect(await repository.getActiveAttempt({ scope, runId: ctx.runId })).toBeNull();
  const attempt = await repository.beginAttempt({
    scope,
    runId: ctx.runId,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  expect(await repository.getActiveAttempt({ scope, runId: ctx.runId })).toEqual(attempt);
  expect(
    await repository.getActiveAttempt({
      scope: { ...scope, ownerUserId: "other" },
      runId: ctx.runId,
    }),
  ).toBeNull();
  expect(await repository.acknowledgeStoppedCancellation({ scope, runId: ctx.runId })).toBe(false);
  await repository.requestCancellation({ scope, runId: ctx.runId, reason: "user_request" });
  expect(
    await repository.acknowledgeStoppedCancellation({
      scope: { ...scope, tenantId: "other" },
      runId: ctx.runId,
    }),
  ).toBe(false);
  expect(await repository.acknowledgeStoppedCancellation({ scope, runId: ctx.runId })).toBe(true);
  expect(await repository.acknowledgeStoppedCancellation({ scope, runId: ctx.runId })).toBe(false);
  expect(await repository.getActiveAttempt({ scope, runId: ctx.runId })).toBeNull();
  await expect(
    repository.checkpoint({ scope, ...attempt, checkpointHash: ctx.inputHash, payloadJson: "{}" }),
  ).rejects.toThrow(StaleWorkerError);
});

test("large run inputs and checkpoints round-trip through R2 with small D1 rows", async () => {
  const repository = repo();
  const ctx = context("large-input");
  const value = { text: "測".repeat(600_000) };
  await repository.createRun({ context: ctx, payload: value });
  expect(
    await runtime.db
      .prepare("SELECT input_json FROM core_runs WHERE run_id=?")
      .bind(ctx.runId)
      .first("input_json"),
  ).toBeNull();
  expect(await repository.getRunInput({ scope, runId: ctx.runId })).toEqual(value);
  const attempt = await repository.beginAttempt({
    scope,
    runId: ctx.runId,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  await repository.checkpoint({
    scope,
    ...attempt,
    checkpointHash: ctx.inputHash,
    payloadJson: JSON.stringify(value),
  });
  expect(
    await runtime.db
      .prepare("SELECT payload_json FROM core_stage_checkpoints WHERE run_id=?")
      .bind(ctx.runId)
      .first("payload_json"),
  ).toBeNull();
  const checkpoint = await repository.readCheckpoint({
    scope,
    runId: ctx.runId,
    stage: attempt.stage,
  });
  expect(JSON.parse(checkpoint!.payloadJson)).toEqual(value);
});

test("large snapshots, reports and claim projections preserve the complete report contract", async () => {
  const repository = repo();
  const largeScope = { ...scope, ownerUserId: "large-owner" };
  const ctx = { ...context("large-report"), ...largeScope };
  const report = structuredClone(completeRunReportExample);
  report.runId = ctx.runId;
  report.replayManifest.runId = ctx.runId;
  report.snapshots[0]!.normalizedText += "測".repeat(600_000);
  report.claims[0]!.retrievalText = "large claim ".repeat(160_000);
  for (const snapshot of report.snapshots)
    await repository.putSnapshot({ scope: largeScope, snapshot });
  const snapshot = report.snapshots[0]!;
  expect(await repository.getSnapshot({ scope: largeScope, snapshotId: snapshot.id })).toEqual(
    snapshot,
  );
  expect(
    await runtime.db
      .prepare("SELECT normalized_text FROM core_snapshots WHERE owner_user_id=? AND snapshot_id=?")
      .bind(largeScope.ownerUserId, snapshot.id)
      .first("normalized_text"),
  ).toBeNull();
  await repository.createRun({ context: ctx });
  const attempt = await repository.beginAttempt({
    scope: largeScope,
    runId: ctx.runId,
    stage: "score_report",
    expectedVersion: 0,
  });
  await repository.finalize({ scope: largeScope, ...attempt, reportHash: ctx.inputHash, report });
  expect(await repository.getLatestReport({ scope: largeScope, runId: ctx.runId })).toEqual(report);
  const summaries = await createD1AnalysisRepository({ database: runtime.db }).listRunSummaries({
    scope: largeScope,
    limit: 30,
  });
  expect(summaries).toEqual([
    {
      runId: ctx.runId,
      status: report.status,
      createdAt: "2026-10-12T00:00:00.000Z",
      headline: report.claims[0]!.text,
      score: report.scorecard?.factualScore ?? null,
    },
  ]);
  await runtime.db
    .prepare("UPDATE core_report_versions SET summary_headline=NULL WHERE run_id=?")
    .bind(ctx.runId)
    .run();
  expect(await repository.listRunSummaries({ scope: largeScope, limit: 30 })).toEqual(summaries);
  const claim = await runtime.db
    .prepare("SELECT claim FROM core_report_claims WHERE run_id=?")
    .bind(ctx.runId)
    .first<string>("claim");
  const pointer = JSON.parse(claim!);
  expect(pointer.r2Payload.uri).toMatch(/^r2:\/\/payloads\/reports\//);
  expect(await repository.payloads.readProjection(pointer)).toEqual(report.claims[0]);
});

test("superseded and canceled attempts cannot publish any report projection", async () => {
  const repository = repo();
  const ctx = context("finalize-fences");
  await repository.createRun({ context: ctx });
  const old = await repository.beginAttempt({
    scope,
    runId: ctx.runId,
    stage: "score_report",
    expectedVersion: 0,
  });
  const current = await repository.beginAttempt({
    scope,
    runId: ctx.runId,
    stage: "score_report",
    expectedVersion: 1,
  });
  const report = structuredClone(completeRunReportExample);
  report.runId = ctx.runId;
  report.replayManifest.runId = ctx.runId;
  for (const snapshot of report.snapshots) await repository.putSnapshot({ scope, snapshot });
  await expect(
    repository.finalize({ scope, ...old, reportHash: ctx.inputHash, report }),
  ).rejects.toThrow(StaleWorkerError);
  await repository.requestCancellation({ scope, runId: ctx.runId, reason: "user_request" });
  await expect(
    repository.finalize({ scope, ...current, reportHash: ctx.inputHash, report }),
  ).rejects.toThrow(StaleWorkerError);
  for (const table of [
    "core_report_versions",
    "core_report_snapshots",
    "core_report_claims",
    "core_evidence_assessments",
    "core_provenance_edges",
    "core_decisions",
  ])
    expect(
      await runtime.db
        .prepare(`SELECT count(*) FROM ${table} WHERE run_id=?`)
        .bind(ctx.runId)
        .first("count(*)"),
    ).toBe(0);
});

test("concurrent duplicate run creation stores one immutable identity", async () => {
  const repository = repo();
  const ctx = context("duplicate-run");
  const results = await Promise.all([
    repository.createRun({ context: ctx, payload: { input: "same" } }),
    repository.createRun({ context: ctx, payload: { input: "same" } }),
  ]);
  expect(results.filter((result) => result.created)).toHaveLength(1);
  expect(await repository.getRunContext({ scope, runId: ctx.runId })).toEqual(ctx);
  expect(await repository.getRunInput({ scope, runId: ctx.runId })).toEqual({ input: "same" });
  await expect(
    repository.createRun({ context: ctx, payload: { input: "different" } }),
  ).rejects.toThrow(AnalysisStorageConflictError);
  expect(
    await repository.getRunContext({ scope: { ...scope, tenantId: "other" }, runId: ctx.runId }),
  ).toBeNull();
});

test("a conditional version update admits only one concurrent attempt", async () => {
  const repository = repo();
  const ctx = context("concurrent-attempt");
  await repository.createRun({ context: ctx });
  const input = { scope, runId: ctx.runId, stage: "normalize_input" as const, expectedVersion: 0 };
  const results = await Promise.allSettled([
    repository.beginAttempt(input),
    repository.beginAttempt(input),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected")!;
  expect(rejected.status === "rejected" && rejected.reason).toBeInstanceOf(StaleWorkerError);
  expect(
    await runtime.db
      .prepare("SELECT count(*) FROM core_stage_attempts WHERE run_id=?")
      .bind(ctx.runId)
      .first("count(*)"),
  ).toBe(1);
});

test("checkpoint writes reject superseded attempts and survive retry resumption", async () => {
  const repository = repo();
  const ctx = context("checkpoint-retry");
  await repository.createRun({ context: ctx });
  const first = await repository.beginAttempt({
    scope,
    runId: ctx.runId,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  await repository.checkpoint({
    scope,
    ...first,
    checkpointHash: ctx.inputHash,
    payloadJson: '{"synthetic":true}',
  });
  const second = await repository.beginAttempt({
    scope,
    runId: ctx.runId,
    stage: "extract_claims",
    expectedVersion: 2,
  });
  expect(second.fencingToken).not.toBe(first.fencingToken);
  await expect(
    repository.checkpoint({ scope, ...first, checkpointHash: ctx.inputHash, payloadJson: "{}" }),
  ).rejects.toThrow(StaleWorkerError);
  expect(
    await repository.readCheckpoint({ scope, runId: ctx.runId, stage: "normalize_input" }),
  ).toEqual({ checkpointHash: ctx.inputHash, payloadJson: '{"synthetic":true}' });
  expect(
    await repository.readCheckpoint({
      scope: { ...scope, ownerUserId: "other" },
      runId: ctx.runId,
      stage: "normalize_input",
    }),
  ).toBeNull();
});

test("snapshot identities are immutable, idempotent and isolated by full ownership scope", async () => {
  const repository = repo();
  const snapshot = structuredClone(completeRunReportExample.snapshots[0]!);
  await Promise.all([
    repository.putSnapshot({ scope, snapshot }),
    repository.putSnapshot({ scope, snapshot }),
  ]);
  expect(await repository.getSnapshot({ scope, snapshotId: snapshot.id })).toEqual(snapshot);
  await expect(
    repository.putSnapshot({
      scope,
      snapshot: { ...snapshot, normalizedText: snapshot.normalizedText + "changed" },
    }),
  ).rejects.toThrow();
  expect(
    await repository.getSnapshot({
      scope: { ...scope, visibility: "public" },
      snapshotId: snapshot.id,
    }),
  ).toBeNull();
  expect(
    await repository.getSnapshots({
      scope: { ...scope, tenantId: "other" },
      snapshotIds: [snapshot.id],
    }),
  ).toEqual([]);
  expect(
    await repository.getSnapshots({
      scope,
      snapshotIds: [snapshot.id, ...Array.from({ length: 110 }, (_, i) => `missing-${i}`)],
    }),
  ).toEqual([snapshot]);
});

test("cancellation is scoped and only the current attempt can acknowledge it", async () => {
  const repository = repo();
  const ctx = context("cancel-active");
  await repository.createRun({ context: ctx });
  const attempt = await repository.beginAttempt({
    scope,
    runId: ctx.runId,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  expect(
    await repository.requestCancellation({
      scope: { ...scope, ownerUserId: "other" },
      runId: ctx.runId,
      reason: "user_request",
    }),
  ).toBe(false);
  expect(
    await repository.requestCancellation({ scope, runId: ctx.runId, reason: "user_request" }),
  ).toBe(true);
  await expect(
    repository.checkpoint({ scope, ...attempt, checkpointHash: ctx.inputHash, payloadJson: "{}" }),
  ).rejects.toThrow(StaleWorkerError);
  await expect(
    repository.acknowledgeCancellation({ scope, ...attempt, fencingToken: "stale" }),
  ).rejects.toThrow(StaleWorkerError);
  await repository.acknowledgeCancellation({ scope, ...attempt });
  expect((await repository.getRunProgress({ scope, runId: ctx.runId }))?.status).toBe("canceled");
  expect(
    await repository.getRunProgress({ scope: { ...scope, tenantId: "other" }, runId: ctx.runId }),
  ).toBeNull();
});

test("queued cancellation and terminal failure prevent later attempt claims", async () => {
  const repository = repo();
  const queued = context("cancel-queued");
  await repository.createRun({ context: queued });
  await repository.requestCancellation({ scope, runId: queued.runId, reason: "user_request" });
  expect((await repository.getRunProgress({ scope, runId: queued.runId }))?.status).toBe(
    "canceled",
  );
  const failed = context("failed-run");
  await repository.createRun({ context: failed });
  await repository.failRun({
    scope,
    runId: failed.runId,
    fencingToken: null,
    error: "synthetic failure",
  });
  expect(
    await repository.requestCancellation({ scope, runId: failed.runId, reason: "user_request" }),
  ).toBe(false);
  await expect(
    repository.beginAttempt({
      scope,
      runId: failed.runId,
      stage: "normalize_input",
      expectedVersion: 1,
    }),
  ).rejects.toThrow(StaleWorkerError);
});

test("finalization rejects missing evidence, then atomically publishes one concurrent completion", async () => {
  const repository = repo();
  const ctx = context("finalize-run");
  await repository.createRun({ context: ctx });
  const attempt = await repository.beginAttempt({
    scope,
    runId: ctx.runId,
    stage: "score_report",
    expectedVersion: 0,
  });
  const report = structuredClone(completeRunReportExample);
  report.runId = ctx.runId;
  report.replayManifest.runId = ctx.runId;
  const privateScope = { ...scope, ownerUserId: "finalize-owner" };
  const privateContext = {
    ...ctx,
    runId: "finalize-private",
    ownerUserId: privateScope.ownerUserId,
  };
  await repository.createRun({ context: privateContext });
  const privateAttempt = await repository.beginAttempt({
    scope: privateScope,
    runId: privateContext.runId,
    stage: "score_report",
    expectedVersion: 0,
  });
  const privateReport = structuredClone(report);
  privateReport.runId = privateContext.runId;
  privateReport.replayManifest.runId = privateContext.runId;
  await expect(
    repository.finalize({
      scope: privateScope,
      ...privateAttempt,
      reportHash: ctx.inputHash,
      report: privateReport,
    }),
  ).rejects.toThrow(AnalysisStorageConflictError);
  expect(
    (await repository.getRunProgress({ scope: privateScope, runId: privateContext.runId }))?.status,
  ).toBe("running");
  for (const snapshot of report.snapshots) await repository.putSnapshot({ scope, snapshot });
  const input = { scope, ...attempt, reportHash: ctx.inputHash, report };
  const results = await Promise.allSettled([
    repository.finalize(input),
    repository.finalize(input),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await repository.getLatestReport({ scope, runId: ctx.runId })).toEqual(report);
  expect(
    await repository.getLatestReport({
      scope: { ...scope, ownerUserId: "other" },
      runId: ctx.runId,
    }),
  ).toBeNull();
  expect(await repository.getReportVersion({ scope, runId: ctx.runId, version: 1 })).toEqual(
    report,
  );
  const stored = await runtime.db
    .prepare("SELECT factual_score,diagnostic_labels FROM core_report_versions WHERE run_id=?")
    .bind(ctx.runId)
    .first<{ factual_score: number; diagnostic_labels: string }>();
  expect(stored!.factual_score).toBe(report.scorecard?.factualScore);
  expect(JSON.parse(stored!.diagnostic_labels)).toEqual(
    report.decisions.map(({ claimId, diagnosticLabel }) => ({ claimId, label: diagnosticLabel })),
  );
});

test("run history and completed-report reuse stay inside the ownership scope", async () => {
  const repository = repo();
  const prepare = vi.fn((sql: string) => runtime.db.prepare(sql));
  const history = await createD1AnalysisRepository({
    database: { prepare } as unknown as typeof runtime.db,
    bucket: runtime.bucket,
  }).listRuns({ scope, limit: 100 });
  expect(prepare).toHaveBeenCalledTimes(1);
  prepare.mockClear();
  const summaries = await createD1AnalysisRepository({
    database: { prepare } as unknown as typeof runtime.db,
  }).listRunSummaries({ scope, limit: 100 });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(summaries).toEqual(
    history.map(({ report, ...run }) => ({
      ...run,
      headline:
        report?.claims.find(
          ({ duplicateOfClaimId, coverageDisposition }) =>
            duplicateOfClaimId === null && coverageDisposition !== "deferred",
        )?.text ??
        report?.claims.find(({ duplicateOfClaimId }) => duplicateOfClaimId === null)?.text ??
        "Focused analysis",
      score: report?.scorecard?.factualScore ?? null,
    })),
  );
  expect(
    await repository.listRunSummaries({ scope: { ...scope, ownerUserId: "other" }, limit: 100 }),
  ).toEqual([]);
  await expect(repository.listRunSummaries({ scope, limit: 0 })).rejects.toThrow(RangeError);
  expect(history.some((run) => run.runId === "finalize-run" && run.report !== null)).toBe(true);
  expect(await repository.listRuns({ scope: { ...scope, tenantId: "other" }, limit: 100 })).toEqual(
    [],
  );
  expect(
    (await repository.findLatestCompletedReport({ scope, inputHash: runContextExample.inputHash }))
      ?.runId,
  ).toBe("finalize-run");
  expect(
    await repository.findLatestCompletedReport({
      scope: { ...scope, visibility: "public" },
      inputHash: runContextExample.inputHash,
    }),
  ).toBeNull();
});

test("an injected projection failure rolls back report publication and run completion", async () => {
  const repository = repo();
  const ctx = context("rollback-run");
  await repository.createRun({ context: ctx });
  const attempt = await repository.beginAttempt({
    scope,
    runId: ctx.runId,
    stage: "score_report",
    expectedVersion: 0,
  });
  const report = structuredClone(completeRunReportExample);
  report.runId = ctx.runId;
  report.replayManifest.runId = ctx.runId;
  await runtime.db
    .prepare(
      "CREATE TRIGGER reject_decision BEFORE INSERT ON core_decisions BEGIN SELECT RAISE(ABORT,'injected projection failure'); END",
    )
    .run();
  try {
    await expect(
      repository.finalize({ scope, ...attempt, reportHash: ctx.inputHash, report }),
    ).rejects.toThrow(/injected/);
    expect(await repository.getLatestReport({ scope, runId: ctx.runId })).toBeNull();
    expect((await repository.getRunProgress({ scope, runId: ctx.runId }))?.status).toBe("running");
    expect(
      await runtime.db
        .prepare("SELECT count(*) FROM core_report_snapshots WHERE run_id=?")
        .bind(ctx.runId)
        .first("count(*)"),
    ).toBe(0);
  } finally {
    await runtime.db.prepare("DROP TRIGGER reject_decision").run();
  }
  await repository.finalize({ scope, ...attempt, reportHash: ctx.inputHash, report });
  expect(await repository.getLatestReport({ scope, runId: ctx.runId })).toEqual(report);
});

test("progress polling projects metadata without returning the submitted payload", async () => {
  const prepare = vi.fn((sql: string) => runtime.db.prepare(sql));
  const database = {
    prepare,
    batch: runtime.db.batch.bind(runtime.db),
  } as unknown as typeof runtime.db;
  const repository = createD1AnalysisRepository({ database });
  const ctx = context("progress-projection");
  await repository.createRun({ context: ctx, payload: { text: "x".repeat(100_000) } });
  prepare.mockClear();
  expect(await repository.getRunProgress({ scope, runId: ctx.runId })).toMatchObject({
    runId: ctx.runId,
    status: "queued",
    completedStages: [],
    cancellationRequested: false,
  });
  expect(
    prepare.mock.calls.every(([sql]) => !sql.includes("SELECT *") && !sql.includes("input_json")),
  ).toBe(true);
  expect(
    await repository.getRunProgress({
      scope: { ...scope, ownerUserId: "other" },
      runId: ctx.runId,
    }),
  ).toBeNull();
});

test("snapshot bulk reads overlap R2 requests within a bounded window and preserve order", async () => {
  const repository = repo();
  const bulkScope = { ...scope, ownerUserId: "bulk-snapshots" };
  const snapshots = Array.from({ length: 12 }, (_, index) => ({
    ...structuredClone(completeRunReportExample.snapshots[0]!),
    id: `bulk-${String(index).padStart(2, "0")}`,
  }));
  for (const snapshot of snapshots) {
    await repository.putSnapshot({ scope: bulkScope, snapshot });
    const pointer = await repository.payloads.encode(snapshot, "snapshots", 0, true);
    await runtime.db
      .prepare(
        "UPDATE core_snapshots SET snapshot=NULL,normalized_text=NULL,snapshot_blob_uri=? WHERE snapshot_id=? AND owner_user_id=?",
      )
      .bind(pointer.blobUri, snapshot.id, bulkScope.ownerUserId)
      .run();
  }
  let active = 0;
  let maximum = 0;
  const bucket = {
    get: async (key: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        return await runtime.bucket.get(key);
      } finally {
        active -= 1;
      }
    },
  } as unknown as typeof runtime.bucket;
  const reader = createD1AnalysisRepository({ database: runtime.db, bucket });
  const ids = snapshots.map(({ id }) => id).reverse();
  expect(
    await reader.getSnapshots({ scope: bulkScope, snapshotIds: [...ids, ids[0]!, "missing"] }),
  ).toEqual(snapshots);
  expect(maximum).toBeGreaterThan(1);
  expect(maximum).toBeLessThanOrEqual(8);
  expect(
    await reader.getSnapshots({ scope: { ...bulkScope, tenantId: "other" }, snapshotIds: ids }),
  ).toEqual([]);
});
