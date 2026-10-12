import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { runAnalysisWorkflow } from "../src/server/analysis-workflow-runner.server";
import {
  analysisStorage,
  accessScope,
  readRunState,
  startAnalysisRun,
} from "../src/server/analysis-api.server";
import { createWorkflowAnalysisPorts } from "../src/server/analysis-runtime";
import type { AnalysisWorkflowParams } from "../src/server/workflow-params";
import type { SessionUser } from "../src/server/session";
import { createWorkerTestEnv, ORIGIN, signIn } from "./support/worker-env";

let harness: Awaited<ReturnType<typeof createWorkerTestEnv>>;
let user: SessionUser;
beforeAll(async () => {
  harness = await createWorkerTestEnv({
    ANALYSIS_USER_CONCURRENCY_LIMIT: "1",
    ANALYSIS_IP_CONCURRENCY_LIMIT: "1",
    ANALYSIS_USER_RATE_LIMIT: "100",
    ANALYSIS_IP_RATE_LIMIT: "100",
  });
  user = (await signIn(harness.env, "ada")).user;
});
afterAll(async () => {
  await harness?.dispose();
});
const body = { text: "The city opened a public library in 2026. The library has 20000 books." };
async function start() {
  const idempotencyKey = crypto.randomUUID();
  const result = await startAnalysisRun({
    env: harness.env,
    user,
    request: new Request(ORIGIN),
    body,
    idempotencyKey,
  });
  expect(result.status).toBe(202);
  return { params: harness.created.at(-1)!.params as AnalysisWorkflowParams, idempotencyKey };
}
function steps() {
  const results: { name: string; value: unknown }[] = [];
  const errors: string[] = [];
  const retries: Record<string, number> = {};
  const step = {
    async do(
      name: string,
      options: WorkflowStepConfig | (() => Promise<unknown>),
      callback?: () => Promise<unknown>,
    ) {
      const execute = typeof options === "function" ? options : callback!;
      const limit = typeof options === "function" ? 2 : (options.retries?.limit ?? 2);
      for (let attempt = 0; ; attempt++) {
        try {
          const value = await execute();
          results.push({ name, value });
          return value;
        } catch (error) {
          errors.push(String(error));
          if (attempt >= limit || (error instanceof Error && error.name === "NonRetryableError"))
            throw error;
          retries[name] = (retries[name] ?? 0) + 1;
        }
      }
    },
  } as unknown as Pick<WorkflowStep, "do">;
  return { step, results, errors, retries };
}
async function heldLeases() {
  return harness.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM analysis_leases WHERE released_at IS NULL",
  ).first<number>("count");
}

test("Workflow analyzes, finalizes and releases admission without persisting report content in steps", async () => {
  const { params, idempotencyKey } = await start();
  const replay = steps();
  expect(await runAnalysisWorkflow(harness.env, params, replay.step)).toEqual({
    runId: params.runId,
    status: "partial",
  });
  expect(replay.results.map(({ name }) => name)).toEqual(["analyze", "finalize", "release"]);
  const state = await readRunState(harness.env, user, params.runId);
  expect(state?.progress.completedStages).toHaveLength(8);
  expect(
    state?.report?.decisions.every(({ publishedLabel }) => publishedLabel === "unverified"),
  ).toBe(true);
  expect(state?.report?.scorecard?.factualScore).toBeNull();
  expect(state?.report?.snapshots[0]?.blobLocator.status).toBe("stored");
  expect(JSON.stringify(replay.results)).not.toContain("library");
  expect(JSON.stringify(replay.results).length).toBeLessThan(1000);
  expect(await heldLeases()).toBe(0);
  const response = await startAnalysisRun({
    env: harness.env,
    user,
    request: new Request(ORIGIN),
    body,
    idempotencyKey,
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ runId: params.runId, status: "partial" });
  await runAnalysisWorkflow(harness.env, params, steps().step);
  expect(
    await harness.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM core_report_versions WHERE run_id=?",
    )
      .bind(params.runId)
      .first("count"),
  ).toBe(1);
});

test("an injected persistence failure resumes from the completed normalization checkpoint", async () => {
  const { params } = await start();
  const storage = analysisStorage(harness.env);
  const checkpoint = storage.runs.checkpoint.bind(storage.runs);
  let normalizations = 0;
  storage.runs.checkpoint = async (request) => {
    await checkpoint(request);
    if (request.stage === "normalize_input" && ++normalizations === 1)
      throw new Error("secret-provider-canary");
  };
  let generations = 0;
  const createPorts: typeof createWorkflowAnalysisPorts = (input) => {
    const ports = createWorkflowAnalysisPorts(input);
    const generate = ports.generation.generate.bind(ports.generation);
    ports.generation.generate = async (request) => {
      generations++;
      return generate(request);
    };
    return ports;
  };
  const replay = steps();
  const result = await runAnalysisWorkflow(harness.env, params, replay.step, {
    storage,
    createPorts,
  });
  expect(result.status).toBe("partial");
  expect(replay.retries.analyze).toBe(1);
  expect(normalizations).toBe(1);
  expect(generations).toBe(1);
  expect((await readRunState(harness.env, user, params.runId))?.progress.attempt).toBe(2);
  expect(JSON.stringify(replay.errors)).not.toContain("secret-provider-canary");
  expect(await heldLeases()).toBe(0);
});

test("finalization retries do not create another report version", async () => {
  const { params } = await start();
  const storage = analysisStorage(harness.env);
  const finalize = storage.runs.finalize.bind(storage.runs);
  const finalizeMock = vi.fn<typeof storage.runs.finalize>(async (request) => {
    await finalize(request);
    throw new Error("connection lost after commit");
  });
  storage.runs.finalize = finalizeMock;
  const replay = steps();
  await runAnalysisWorkflow(harness.env, params, replay.step, { storage });
  expect(replay.retries.finalize).toBe(1);
  expect(finalizeMock).toHaveBeenCalledTimes(1);
  expect(await heldLeases()).toBe(0);
});

test("exhausted attempts fail safely and release the concurrency slot", async () => {
  const { params } = await start();
  const createPorts: typeof createWorkflowAnalysisPorts = () => {
    throw new Error("secret-key-that-must-not-persist");
  };
  const replay = steps();
  expect(
    (await runAnalysisWorkflow(harness.env, params, replay.step, { createPorts })).status,
  ).toBe("failed");
  expect(replay.retries.analyze).toBe(2);
  expect(JSON.stringify(replay.errors)).not.toContain("secret-key");
  const row = await harness.env.DB.prepare(
    "SELECT last_error,attempt FROM core_runs WHERE run_id=?",
  )
    .bind(params.runId)
    .first<{ last_error: string; attempt: number }>();
  expect(row?.attempt).toBe(3);
  expect(row?.last_error).toBe("The analysis Workflow exhausted its retries.");
  expect(await heldLeases()).toBe(0);
});

test("the next checkpoint observes owner cancellation and the Workflow releases admission", async () => {
  const { params } = await start();
  const storage = analysisStorage(harness.env);
  const createPorts: typeof createWorkflowAnalysisPorts = (input) => {
    const ports = createWorkflowAnalysisPorts(input);
    const generate = ports.generation.generate.bind(ports.generation);
    ports.generation.generate = async (request) => {
      await storage.runs.requestCancellation({
        scope: accessScope(user),
        runId: params.runId,
        reason: "user_request",
      });
      return generate(request);
    };
    return ports;
  };
  expect(
    (await runAnalysisWorkflow(harness.env, params, steps().step, { storage, createPorts })).status,
  ).toBe("canceled");
  expect((await readRunState(harness.env, user, params.runId))?.report).toBeNull();
  expect(await heldLeases()).toBe(0);
});
