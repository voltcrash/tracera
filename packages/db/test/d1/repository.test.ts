import {
  completeRunReportExample,
  runContextExample,
  type RunContext,
} from "@repo/contracts/analysis";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import {
  createD1AnalysisRepository,
  AnalysisStorageConflictError,
  StaleWorkerError,
} from "../../src/d1/repository.js";
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
