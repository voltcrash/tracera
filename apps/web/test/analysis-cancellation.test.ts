import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import {
  terminateCanceledRun,
  CANCELLATION_GRACE_MS,
} from "../src/server/analysis-cancellation.server";
import {
  accessScope,
  analysisStorage,
  cancelAnalysisRun,
  readRunState,
  startAnalysisRun,
} from "../src/server/analysis-api.server";
import type { SessionUser } from "../src/server/session";
import { createWorkerTestEnv, ORIGIN, signIn } from "./support/worker-env";

let harness: Awaited<ReturnType<typeof createWorkerTestEnv>>;
let user: SessionUser;
beforeAll(async () => {
  harness = await createWorkerTestEnv();
  user = (await signIn(harness.env, "ada")).user;
});
afterAll(async () => {
  await harness?.dispose();
});

async function start(running = false) {
  const result = await startAnalysisRun({
    env: harness.env,
    user,
    request: new Request(ORIGIN),
    body: { text: "The city opened a public library in 2026." },
    idempotencyKey: crypto.randomUUID(),
  });
  expect(result.status).toBe(202);
  const runId = result.body.runId as string;
  if (running)
    await analysisStorage(harness.env).runs.beginAttempt({
      scope: accessScope(user),
      runId,
      stage: "normalize_input",
      expectedVersion: 0,
    });
  return runId;
}
function binding(terminate = vi.fn(async () => {}), status = "running") {
  const get = vi.fn(async () => ({ status: async () => ({ status }), terminate }));
  return {
    env: { ...harness.env, ANALYSIS_WORKFLOW: { get } as unknown as Workflow },
    get,
    terminate,
  };
}

test("after the grace period, termination cancels a running run and releases admission", async () => {
  const runId = await start(true);
  await cancelAnalysisRun(harness.env, user, runId);
  const workflow = binding();
  const sleep = vi.fn(async () => {});
  await terminateCanceledRun(workflow.env, user.id, runId, sleep);
  expect(sleep).toHaveBeenCalledWith(CANCELLATION_GRACE_MS);
  expect(workflow.terminate).toHaveBeenCalledTimes(1);
  expect((await readRunState(harness.env, user, runId))?.progress.status).toBe("canceled");
  const params = harness.created.at(-1)!.params as { admission: { leaseId: string } };
  expect(
    await harness.env.DB.prepare("SELECT released_at FROM analysis_leases WHERE id=?")
      .bind(params.admission.leaseId)
      .first("released_at"),
  ).not.toBeNull();
});

test("queued cancellation cleans admission even when the instance already completed", async () => {
  const runId = await start();
  await cancelAnalysisRun(harness.env, user, runId);
  const workflow = binding(undefined, "complete");
  await terminateCanceledRun(workflow.env, user.id, runId, async () => {});
  expect(workflow.terminate).not.toHaveBeenCalled();
  expect((await readRunState(harness.env, user, runId))?.progress.status).toBe("canceled");
});

test("termination failures preserve the running state for a later cleanup", async () => {
  const runId = await start(true);
  await cancelAnalysisRun(harness.env, user, runId);
  const workflow = binding(
    vi.fn(async () => {
      throw new Error("Workflow unavailable");
    }),
  );
  await expect(terminateCanceledRun(workflow.env, user.id, runId, async () => {})).rejects.toThrow(
    "Workflow unavailable",
  );
  expect((await readRunState(harness.env, user, runId))?.progress.status).toBe("running");
  const params = harness.created.at(-1)!.params as { admission: { leaseId: string } };
  expect(
    await harness.env.DB.prepare("SELECT released_at FROM analysis_leases WHERE id=?")
      .bind(params.admission.leaseId)
      .first("released_at"),
  ).toBeNull();
  await terminateCanceledRun(binding().env, user.id, runId, async () => {});
});

test("another owner's cancellation cannot terminate an instance", async () => {
  const runId = await start(true);
  await cancelAnalysisRun(harness.env, user, runId);
  const workflow = binding();
  await terminateCanceledRun(workflow.env, "another-owner", runId, async () => {});
  expect(workflow.get).not.toHaveBeenCalled();
  await terminateCanceledRun(workflow.env, user.id, runId, async () => {});
});
