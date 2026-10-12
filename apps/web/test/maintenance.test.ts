import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { WorkflowStep } from "cloudflare:workers";
import { runAnalysisWorkflow } from "../src/server/analysis-workflow-runner.server";
import type { AnalysisWorkflowParams } from "../src/server/workflow-params";
import { scheduledMaintenance } from "../src/server/maintenance.server";
import {
  accessScope,
  analysisStorage,
  cancelAnalysisRun,
  readRunState,
  startAnalysisRun,
} from "../src/server/analysis-api.server";
import { analysisPolicy, analysisRunContext } from "../src/server/analysis-policy";
import { CANCELLATION_GRACE_MS } from "../src/server/analysis-cancellation.server";
import type { SessionUser } from "../src/server/session";
import { createWorkerTestEnv, ORIGIN, signIn } from "./support/worker-env";

let harness: Awaited<ReturnType<typeof createWorkerTestEnv>>;
let user: SessionUser;
beforeEach(async () => {
  harness = await createWorkerTestEnv();
  user = (await signIn(harness.env, "ada")).user;
});
afterEach(async () => {
  await harness?.dispose();
  vi.restoreAllMocks();
});
async function start() {
  const result = await startAnalysisRun({
    env: harness.env,
    user,
    request: new Request(ORIGIN),
    body: { text: "The city opened a library." },
    idempotencyKey: crypto.randomUUID(),
  });
  expect(result.status).toBe(202);
  return result.body.runId as string;
}
function binding(status: string) {
  const terminate = vi.fn(async () => {});
  return {
    env: {
      ...harness.env,
      ANALYSIS_WORKFLOW: {
        ...harness.workflow,
        get: async () => ({ status: async () => ({ status }), terminate }),
      } as unknown as Workflow,
    },
    terminate,
  };
}

test("errored Workflows fail their scoped run and release admission with a replayable failure", async () => {
  const runId = await start();
  const counts = await scheduledMaintenance(binding("errored").env);
  expect(counts).toMatchObject({ failedRuns: 1, admissionsReleased: 1, leasesPurged: 1 });
  expect((await readRunState(harness.env, user, runId))?.progress.status).toBe("failed");
  expect(
    await harness.env.DB.prepare("SELECT response_status FROM analysis_idempotency_keys").first(
      "response_status",
    ),
  ).toBe(503);
  expect(
    await harness.env.DB.prepare("SELECT last_error FROM core_runs WHERE run_id=?")
      .bind(runId)
      .first("last_error"),
  ).toBe("The analysis Workflow stopped before the run finished.");
});

test("maintenance retries owner cancellation after its grace period", async () => {
  const runId = await start();
  await analysisStorage(harness.env).runs.beginAttempt({
    scope: accessScope(user),
    runId,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  await cancelAnalysisRun(harness.env, user, runId);
  const workflow = binding("running");
  const beforeGrace = await scheduledMaintenance(workflow.env);
  expect(beforeGrace.canceledRuns).toBe(0);
  expect(workflow.terminate).not.toHaveBeenCalled();
  const afterGrace = await scheduledMaintenance(
    workflow.env,
    Date.now() + CANCELLATION_GRACE_MS + 1,
  );
  expect(afterGrace).toMatchObject({ canceledRuns: 1, admissionsReleased: 1 });
  expect(workflow.terminate).toHaveBeenCalledTimes(1);
  expect((await readRunState(harness.env, user, runId))?.progress.status).toBe("canceled");
});

test("a Workflow status outage leaves its run active while expiry cleanup continues", async () => {
  const runId = await start();
  await harness.env.DB.prepare(
    "INSERT INTO verifications(id,identifier,value,expires_at,created_at,updated_at) VALUES('expired','expiry-probe','synthetic',0,0,0)",
  ).run();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const env = {
    ...harness.env,
    ANALYSIS_WORKFLOW: {
      ...harness.workflow,
      get: async () => {
        throw new Error("unavailable");
      },
    } as unknown as Workflow,
  };
  const counts = await scheduledMaintenance(env);
  expect(counts).toMatchObject({
    failedRuns: 0,
    admissionsReleased: 0,
    workflowStatusErrors: 1,
    verificationsPurged: 1,
  });
  expect((await readRunState(harness.env, user, runId))?.progress.status).toBe("queued");
});

test("maintenance completes admission release after a report was already finalized", async () => {
  const runId = await start();
  const params = harness.created.at(-1)!.params as AnalysisWorkflowParams;
  const step = {
    async do(name: string, options: unknown, callback?: () => Promise<unknown>) {
      if (name === "release") throw new Error("Release failed after report finalization.");
      return typeof options === "function" ? options() : callback!();
    },
  } as unknown as Pick<WorkflowStep, "do">;
  await expect(runAnalysisWorkflow(harness.env, params, step)).rejects.toThrow("Release failed");
  expect((await readRunState(harness.env, user, runId))?.progress.status).toBe("partial");
  expect((await scheduledMaintenance(binding("errored").env)).admissionsReleased).toBe(1);
  const state = await readRunState(harness.env, user, runId);
  expect(state?.progress.status).toBe("partial");
  expect(state?.report?.claims.length).toBeGreaterThan(0);
  expect(
    await harness.env.DB.prepare("SELECT response_status FROM analysis_idempotency_keys").first(
      "response_status",
    ),
  ).toBe(200);
});

test("pagination reaches an errored run behind a full page of active instances", async () => {
  const policy = analysisPolicy(harness.env, user.id);
  if (!policy.enabled) throw new Error(policy.message);
  const repository = analysisStorage(harness.env).runs;
  for (let index = 0; index < 101; index++) {
    const context = analysisRunContext(user.id, { kind: "text", text: "A claim." }, policy.policy);
    context.runId = index === 100 ? "zz-errored" : `active-${String(index).padStart(3, "0")}`;
    await repository.createRun({
      context,
      payload: { input: { kind: "text", text: "A claim." }, seed: 1 },
    });
  }
  const env = {
    ...harness.env,
    ANALYSIS_WORKFLOW: {
      ...harness.workflow,
      get: async (runId: string) => ({
        status: async () => ({ status: runId === "zz-errored" ? "errored" : "running" }),
      }),
    } as unknown as Workflow,
  };
  expect((await scheduledMaintenance(env)).failedRuns).toBe(1);
  expect((await readRunState(harness.env, user, "zz-errored"))?.progress.status).toBe("failed");
}, 15_000);

test("maintenance stops a paused instance after queued cancellation", async () => {
  const runId = await start();
  await cancelAnalysisRun(harness.env, user, runId);
  const workflow = binding("paused");
  expect(
    (await scheduledMaintenance(workflow.env, Date.now() + CANCELLATION_GRACE_MS + 1))
      .admissionsReleased,
  ).toBe(1);
  expect(workflow.terminate).toHaveBeenCalledTimes(1);
  expect((await readRunState(harness.env, user, runId))?.progress.status).toBe("canceled");
});
