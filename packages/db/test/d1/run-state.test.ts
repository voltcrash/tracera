import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { runContextExample } from "@repo/contracts/analysis";
import { createD1AnalysisRepository, StaleWorkerError } from "../../src/repository.js";
import { createTestRuntime } from "./runtime.js";
let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let now: number;
beforeEach(async () => {
  runtime = await createTestRuntime();
  now = Date.parse("2026-11-07T00:00:00Z");
});
afterEach(async () => {
  await runtime?.dispose();
});
const scope = { tenantId: "states", ownerUserId: "owner", visibility: "private" as const };
async function setup() {
  const runs = createD1AnalysisRepository({ database: runtime.db, now: () => now });
  const context = { ...structuredClone(runContextExample), ...scope, runId: "run" };
  await runs.createRun({ context });
  return { runs, identity: { scope, runId: context.runId } };
}

test("terminal states require finalization and cannot be reopened", async () => {
  const { runs, identity } = await setup();
  await expect(
    runtime.db.prepare("UPDATE core_runs SET status='failed' WHERE run_id='run'").run(),
  ).rejects.toThrow();
  await expect(
    runtime.db.prepare("UPDATE core_runs SET finalized_at=1 WHERE run_id='run'").run(),
  ).rejects.toThrow();
  await runs.failRun({ ...identity, fencingToken: null, error: "Stopped" });
  await expect(
    runtime.db
      .prepare("UPDATE core_runs SET status='queued',finalized_at=NULL WHERE run_id='run'")
      .run(),
  ).rejects.toThrow();
});

test("running runs require a positive fenced attempt and attempt outcomes require completion times", async () => {
  const { runs, identity } = await setup();
  await expect(
    runtime.db.prepare("UPDATE core_runs SET status='running' WHERE run_id='run'").run(),
  ).rejects.toThrow();
  const attempt = await runs.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  await expect(
    runtime.db.prepare("UPDATE core_stage_attempts SET outcome='failed' WHERE run_id='run'").run(),
  ).rejects.toThrow();
  await runs.failRun({ ...identity, fencingToken: attempt.fencingToken, error: "Stopped" });
});

test("late cancellation acknowledgments cannot rewrite settled attempt timestamps", async () => {
  const { runs, identity } = await setup();
  const attempt = await runs.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  await runs.requestCancellation({ ...identity, reason: "user_request" });
  await runs.acknowledgeCancellation({ scope, ...attempt });
  const settled = await runtime.db
    .prepare("SELECT finished_at FROM core_stage_attempts WHERE run_id='run'")
    .first("finished_at");
  now += 10_000;
  await expect(runs.acknowledgeCancellation({ scope, ...attempt })).rejects.toThrow(
    StaleWorkerError,
  );
  expect(
    await runtime.db
      .prepare("SELECT finished_at FROM core_stage_attempts WHERE run_id='run'")
      .first("finished_at"),
  ).toBe(settled);
});

test("progress names recorded checkpoints separately from successful completion", async () => {
  const { runs, identity } = await setup();
  const attempt = await runs.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  await runs.checkpoint({
    scope,
    ...attempt,
    checkpointHash: "checkpoint",
    payloadJson: JSON.stringify({ status: "unavailable", data: null }),
  });
  expect(await runs.getRunProgress(identity)).toMatchObject({
    status: "running",
    recordedStages: ["normalize_input"],
    lastCheckpointedStage: "normalize_input",
    nextStage: "extract_claims",
  });
  expect(
    await runtime.db
      .prepare("SELECT outcome FROM core_stage_attempts WHERE run_id='run'")
      .first("outcome"),
  ).toBeNull();
});

test("settled attempts reject direct timestamp and outcome rewrites", async () => {
  const { runs, identity } = await setup();
  const attempt = await runs.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  await runs.failRun({ ...identity, fencingToken: attempt.fencingToken, error: "Stopped" });
  await expect(
    runtime.db
      .prepare("UPDATE core_stage_attempts SET finished_at=finished_at+1 WHERE run_id='run'")
      .run(),
  ).rejects.toThrow();
  await expect(
    runtime.db
      .prepare("UPDATE core_stage_attempts SET outcome='complete' WHERE run_id='run'")
      .run(),
  ).rejects.toThrow();
});

test("the lifecycle migration backfills only missing terminal timestamps", async () => {
  const { runs, identity } = await setup();
  await runs.failRun({ ...identity, fencingToken: null, error: "Stopped" });
  for (const name of [
    "core_runs_insert_state_guard",
    "core_runs_update_state_guard",
    "core_stage_attempts_insert_state_guard",
    "core_stage_attempts_update_state_guard",
  ])
    await runtime.db.prepare(`DROP TRIGGER ${name}`).run();
  await runtime.db.prepare("UPDATE core_runs SET finalized_at=NULL WHERE run_id='run'").run();
  await runs.createRun({
    context: { ...structuredClone(runContextExample), ...scope, runId: "still-queued" },
  });
  const { readFile } = await import("node:fs/promises");
  const migration = await readFile(
    new URL("../../migrations/0008_run_state_guards.sql", import.meta.url),
    "utf8",
  );
  await runtime.db.batch(
    migration
      .split("--> statement-breakpoint")
      .filter((sql) => sql.trim())
      .map((sql) => runtime.db.prepare(sql)),
  );
  expect(
    await runtime.db
      .prepare("SELECT finalized_at FROM core_runs WHERE run_id='run'")
      .first("finalized_at"),
  ).toBe(now);
  expect((await runs.getRunProgress({ scope, runId: "still-queued" }))!.status).toBe("queued");
  expect(
    await runtime.db
      .prepare("SELECT finalized_at FROM core_runs WHERE run_id='still-queued'")
      .first("finalized_at"),
  ).toBeNull();
});
