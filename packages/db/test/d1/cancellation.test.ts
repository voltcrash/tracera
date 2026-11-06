import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { runContextExample } from "@repo/contracts/analysis";
import { createD1AnalysisRepository, StaleWorkerError } from "../../src/repository.js";
import { createTestRuntime } from "./runtime.js";

let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let now = Date.parse("2026-11-07T00:00:00Z");
beforeAll(async () => {
  runtime = await createTestRuntime();
});
afterAll(async () => {
  await runtime?.dispose();
});
const scope = { tenantId: "cancellation", ownerUserId: "owner", visibility: "private" as const };
const runs = () => createD1AnalysisRepository({ database: runtime.db, now: () => now });
async function setup(running = true) {
  const repository = runs();
  const context = { ...structuredClone(runContextExample), ...scope, runId: crypto.randomUUID() };
  await repository.createRun({ context });
  const identity = { scope, runId: context.runId };
  const attempt = running
    ? await repository.beginAttempt({ ...identity, stage: "normalize_input", expectedVersion: 0 })
    : null;
  return { repository, identity, attempt };
}

test.each([false, true])(
  "repeated cancellation preserves the first request for running=%s",
  async (running) => {
    const { repository, identity } = await setup(running);
    expect(await repository.requestCancellation({ ...identity, reason: "user_request" })).toBe(
      true,
    );
    const first = await repository.getRunContext(identity);
    const version = (await repository.getRunProgress(identity))!.version;
    now += 10_000;
    expect(await repository.requestCancellation({ ...identity, reason: "operator_request" })).toBe(
      true,
    );
    expect((await repository.getRunContext(identity))!.cancellation).toEqual(first!.cancellation);
    expect((await repository.getRunProgress(identity))!.version).toBe(version);
  },
);

test("an accepted cancellation wins a later failure write atomically", async () => {
  const { repository, identity, attempt } = await setup();
  await repository.checkpoint({
    scope,
    ...attempt!,
    checkpointHash: "checkpoint",
    payloadJson: "{}",
  });
  await repository.requestCancellation({ ...identity, reason: "user_request" });
  await repository.failRun({
    ...identity,
    fencingToken: attempt!.fencingToken,
    error: "provider_key_rejected",
  });
  expect((await repository.getRunProgress(identity))!.status).toBe("canceled");
  expect(
    await runtime.db
      .prepare("SELECT last_error FROM core_runs WHERE run_id=?")
      .bind(identity.runId)
      .first("last_error"),
  ).toBeNull();
  expect(
    await runtime.db
      .prepare("SELECT outcome FROM core_stage_attempts WHERE run_id=?")
      .bind(identity.runId)
      .first("outcome"),
  ).toBe("canceled");
  const settledAt = await runtime.db
    .prepare("SELECT finished_at FROM core_stage_attempts WHERE run_id=?")
    .bind(identity.runId)
    .first("finished_at");
  now += 1000;
  await expect(
    repository.failRun({ ...identity, fencingToken: attempt!.fencingToken, error: "Late failure" }),
  ).rejects.toThrow(StaleWorkerError);
  expect(
    await runtime.db
      .prepare("SELECT finished_at FROM core_stage_attempts WHERE run_id=?")
      .bind(identity.runId)
      .first("finished_at"),
  ).toBe(settledAt);
});

test("failure that commits first stays terminal and stale failures cannot settle cancellation", async () => {
  const first = await setup();
  await first.repository.failRun({
    ...first.identity,
    fencingToken: first.attempt!.fencingToken,
    error: "Stopped",
  });
  expect(
    await first.repository.requestCancellation({ ...first.identity, reason: "user_request" }),
  ).toBe(false);
  expect((await first.repository.getRunProgress(first.identity))!.status).toBe("failed");
  const second = await setup();
  await second.repository.requestCancellation({ ...second.identity, reason: "user_request" });
  await expect(
    second.repository.failRun({ ...second.identity, fencingToken: "stale", error: "Stopped" }),
  ).rejects.toThrow(StaleWorkerError);
  expect((await second.repository.getRunProgress(second.identity))!.status).toBe("running");
  await second.repository.acknowledgeCancellation({ ...second.identity, ...second.attempt! });
});
