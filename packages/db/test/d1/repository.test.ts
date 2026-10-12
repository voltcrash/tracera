import { runContextExample, type RunContext } from "@repo/contracts/analysis";
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
