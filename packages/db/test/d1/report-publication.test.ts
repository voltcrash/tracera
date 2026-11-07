import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { completeRunReportExample, runContextExample } from "@repo/contracts/analysis";
import { createD1AnalysisRepository, StaleWorkerError } from "../../src/repository.js";
import { hashJson } from "../../src/payloads.js";
import { createTestRuntime } from "./runtime.js";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  runtime = await createTestRuntime();
});
afterAll(async () => {
  await runtime?.dispose();
});
const scope = { tenantId: "publication", ownerUserId: "owner", visibility: "private" as const };

async function setup(runId: string) {
  const runs = createD1AnalysisRepository({ database: runtime.db });
  const identity = { scope, runId };
  await runs.createRun({ context: { ...structuredClone(runContextExample), ...scope, runId } });
  const attempt = await runs.beginAttempt({
    ...identity,
    stage: "score_report",
    expectedVersion: 0,
  });
  const report = structuredClone(completeRunReportExample);
  report.runId = runId;
  report.replayManifest.runId = runId;
  for (const snapshot of report.snapshots) await runs.putSnapshot({ scope, snapshot });
  const prepared = {
    reportUri: `r2://snapshots/${runId}/${"a".repeat(64)}`,
    reportHash: hashJson(report),
    fencingToken: attempt.fencingToken,
    status: "complete" as const,
  };
  return { runs, identity, attempt, report, prepared };
}

test("ready reports retain their fence, reject failure and publish exactly once", async () => {
  const { runs, identity, attempt, report, prepared } = await setup("ready");
  expect(await runs.getPreparedReport(identity)).toBeNull();
  await runs.prepareReport({ ...identity, ...prepared });
  const version = (await runs.getRunProgress(identity))!.version;
  await runs.prepareReport({ ...identity, ...prepared });
  expect((await runs.getRunProgress(identity))!.version).toBe(version);
  expect(await runs.getPreparedReport(identity)).toEqual(prepared);
  expect(
    await runs.getPreparedReport({ ...identity, scope: { ...scope, ownerUserId: "other" } }),
  ).toBeNull();
  await expect(
    runs.beginAttempt({ ...identity, stage: "score_report", expectedVersion: version }),
  ).rejects.toThrow(StaleWorkerError);
  await expect(
    runs.failRun({ ...identity, fencingToken: attempt.fencingToken, error: "Workflow stopped" }),
  ).rejects.toThrow(StaleWorkerError);
  expect(await runs.getActiveAttempt(identity)).toMatchObject({
    fencingToken: attempt.fencingToken,
  });
  expect(
    await runtime.db
      .prepare("SELECT outcome FROM core_stage_attempts WHERE run_id='ready'")
      .first("outcome"),
  ).toBeNull();
  await runs.finalize({
    ...identity,
    fencingToken: attempt.fencingToken,
    reportHash: prepared.reportHash,
    report,
  });
  expect(await runs.getLatestReport(identity)).toEqual(report);
  expect(await runs.getPreparedReport(identity)).toBeNull();
  await expect(
    runs.finalize({
      ...identity,
      fencingToken: attempt.fencingToken,
      reportHash: prepared.reportHash,
      report,
    }),
  ).rejects.toThrow(StaleWorkerError);
});

test("only the active owner and fence can prepare an immutable report", async () => {
  const { runs, identity, attempt, prepared } = await setup("ownership");
  const next = await runs.beginAttempt({
    ...identity,
    stage: "score_report",
    expectedVersion: attempt.version,
  });
  await expect(runs.prepareReport({ ...identity, ...prepared })).rejects.toThrow(StaleWorkerError);
  const active = { ...prepared, fencingToken: next.fencingToken };
  await expect(
    runs.prepareReport({ ...identity, ...active, scope: { ...scope, tenantId: "other" } }),
  ).rejects.toThrow(StaleWorkerError);
  await runs.prepareReport({ ...identity, ...active });
  await expect(
    runs.prepareReport({ ...identity, ...active, reportHash: "different" }),
  ).rejects.toThrow(StaleWorkerError);
  expect(await runs.getPreparedReport(identity)).toEqual(active);
});

test("owner cancellation overrides ready reports and rejects later preparation or publication", async () => {
  const { runs, identity, prepared, report } = await setup("canceled-ready");
  await runs.prepareReport({ ...identity, ...prepared });
  await runs.requestCancellation({ ...identity, reason: "user_request" });
  await expect(runs.prepareReport({ ...identity, ...prepared })).rejects.toThrow(StaleWorkerError);
  await expect(runs.finalize({ ...identity, ...prepared, report })).rejects.toThrow(
    StaleWorkerError,
  );
  expect(
    await runs.failRun({ ...identity, fencingToken: prepared.fencingToken, error: "Stopped" }),
  ).toBe("canceled");
  expect(await runs.getLatestReport(identity)).toBeNull();
  expect(await runs.getPreparedReport(identity)).toBeNull();
});

test("preparation racing failure commits exactly one outcome", async () => {
  const { runs, identity, prepared } = await setup("racing");
  const results = await Promise.allSettled([
    runs.prepareReport({ ...identity, ...prepared }),
    runs.failRun({ ...identity, fencingToken: prepared.fencingToken, error: "Stopped" }),
  ]);
  expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  const ready = await runs.getPreparedReport(identity);
  expect((await runs.getRunProgress(identity))!.status).toBe(ready ? "running" : "failed");
});

test("prepared publication rejects content changed under the same supplied hash", async () => {
  const { runs, identity, prepared, report } = await setup("integrity");
  await runs.prepareReport({ ...identity, ...prepared });
  const changed = structuredClone(report);
  changed.createdAt = "2026-11-08T00:00:00.000Z";
  await expect(runs.finalize({ ...identity, ...prepared, report: changed })).rejects.toThrow(
    "prepared publication",
  );
  expect(await runs.getLatestReport(identity)).toBeNull();
});

test("finalization cannot race past a report that became ready after its initial read", async () => {
  const { runs, identity, prepared, report } = await setup("prepare-during-finalize");
  const snapshots = runs.getSnapshots.bind(runs);
  runs.getSnapshots = async (input) => {
    await runs.prepareReport({ ...identity, ...prepared });
    return snapshots(input);
  };
  await expect(runs.finalize({ ...identity, ...prepared, report })).rejects.toThrow(
    StaleWorkerError,
  );
  expect(await runs.getPreparedReport(identity)).toEqual(prepared);
  expect(await runs.getLatestReport(identity)).toBeNull();
  runs.getSnapshots = snapshots;
  await runs.finalize({ ...identity, ...prepared, report });
  expect(await runs.getLatestReport(identity)).toEqual(report);
});

test("database guards reject malformed readiness, mutation and fence rotation", async () => {
  const { runs, identity, prepared } = await setup("guards");
  for (const value of [
    "not json",
    "{}",
    JSON.stringify({ ...prepared, status: "failed" }),
    JSON.stringify({ ...prepared, fencingToken: "old" }),
  ]) {
    await expect(
      runtime.db
        .prepare("UPDATE core_runs SET prepared_report=? WHERE run_id='guards'")
        .bind(value)
        .run(),
    ).rejects.toThrow();
  }
  await runs.prepareReport({ ...identity, ...prepared });
  await expect(
    runtime.db.prepare("UPDATE core_runs SET prepared_report=NULL WHERE run_id='guards'").run(),
  ).rejects.toThrow();
  await expect(
    runtime.db.prepare("UPDATE core_runs SET fencing_token='new' WHERE run_id='guards'").run(),
  ).rejects.toThrow();
});
