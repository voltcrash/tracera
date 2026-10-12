import { fileURLToPath } from "node:url";
import { bundleTestWorker } from "@repo/ai/test-bundler";
import { createTestRuntime } from "@repo/db/test-runtime";
import { expect, test } from "vite-plus/test";

const source = `
import { WorkflowEntrypoint } from "cloudflare:workers";
import { runAnalysisWorkflow } from "../../src/server/analysis-workflow-runner.server";
import { parseServerEnv } from "../../src/server/env";
import { createWorkflowAnalysisPorts } from "../../src/server/analysis-runtime";
import { accessScope, analysisStorage, readRunState, startAnalysisRun, cancelAnalysisRun } from "../../src/server/analysis-api.server";
import { terminateCanceledRun } from "../../src/server/analysis-cancellation.server";
const user = { id: "workflow-owner" };
export class TestAnalysisWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const env = parseServerEnv(this.env);
    const storage = analysisStorage(env);
    const checkpoint = storage.runs.checkpoint.bind(storage.runs);
    storage.runs.checkpoint = async (request) => {
      await checkpoint(request);
      if (request.stage === "normalize_input" && this.env.FAULT === "true") {
        const inserted = await env.DB.prepare("INSERT INTO test_faults(run_id) VALUES(?) ON CONFLICT DO NOTHING RETURNING run_id").bind(request.runId).all();
        if (inserted.results.length) throw new Error("Injected failure after persisted checkpoint.");
      }
    };
    const createPorts = (input) => {
      const ports = createWorkflowAnalysisPorts(input);
      if (this.env.BLOCK === "true") {
        const generate = ports.generation.generate.bind(ports.generation);
        ports.generation.generate = async (request) => {
          await new Promise(resolve => setTimeout(resolve, 30000));
          return generate(request);
        };
      }
      return ports;
    };
    return runAnalysisWorkflow(env, event.payload, step, { storage, createPorts });
  }
}
export default {
  async fetch(request, bindings) {
    const env = parseServerEnv(bindings);
    const url = new URL(request.url);
    if (url.pathname === "/start") {
      const result = await startAnalysisRun({ env, user, request, body: { text: "The city opened a public library in 2026." }, idempotencyKey: crypto.randomUUID() });
      return Response.json(result.body, { status: result.status });
    }
    const runId = url.searchParams.get("id");
    if (url.pathname === "/cancel") {
      await cancelAnalysisRun(env, user, runId);
      await terminateCanceledRun(env, user.id, runId, async () => {});
    }
    return Response.json({ state: await readRunState(env, user, runId), workflow: await (await env.ANALYSIS_WORKFLOW.get(runId)).status() });
  }
};`;

async function runtime(extra: Record<string, string>) {
  const runtime = await createTestRuntime({
    script: await bundleTestWorker(source, fileURLToPath(new URL("./support/", import.meta.url))),
    bindings: {
      MODE: "dev",
      ANALYSIS_MODE: "fixture",
      BETTER_AUTH_SECRET: "synthetic-secret-long-enough-for-workflows",
      ...extra,
    },
    workflows: { ANALYSIS_WORKFLOW: { name: "analysis-test", className: "TestAnalysisWorkflow" } },
  });
  await runtime.db
    .prepare(
      "INSERT INTO users(id,name,email,created_at,updated_at) VALUES('workflow-owner','Owner','workflow@tracera.local',0,0)",
    )
    .run();
  await runtime.db.prepare("CREATE TABLE test_faults(run_id TEXT PRIMARY KEY)").run();
  return runtime;
}

async function waitForStatus(
  runtime: Awaited<ReturnType<typeof createTestRuntime>>,
  runId: string,
  status: string,
) {
  await expect
    .poll(
      async () => {
        const row = await runtime.db
          .prepare("SELECT status FROM core_runs WHERE run_id=?")
          .bind(runId)
          .first<string>("status");
        return row;
      },
      { timeout: 15_000, interval: 100 },
    )
    .toBe(status);
}

test("workerd Workflows retry from an injected D1 checkpoint failure", async () => {
  const harness = await runtime({ FAULT: "true" });
  try {
    const response = await harness.runtime.dispatchFetch("http://worker/start", { method: "POST" });
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };
    await waitForStatus(harness, runId, "partial");
    const row = await harness.db
      .prepare("SELECT attempt FROM core_runs WHERE run_id=?")
      .bind(runId)
      .first<number>("attempt");
    expect(row).toBe(2);
    expect(
      await harness.db
        .prepare("SELECT COUNT(*) AS count FROM core_stage_checkpoints WHERE run_id=?")
        .bind(runId)
        .first("count"),
    ).toBe(8);
    await expect
      .poll(() =>
        harness.db
          .prepare("SELECT COUNT(*) AS count FROM analysis_leases WHERE released_at IS NULL")
          .first<number>("count"),
      )
      .toBe(0);
  } finally {
    await harness.dispose();
  }
}, 30_000);

test("workerd can terminate an active analysis and release its admission", async () => {
  const harness = await runtime({ BLOCK: "true" });
  try {
    const response = await harness.runtime.dispatchFetch("http://worker/start", { method: "POST" });
    const { runId } = (await response.json()) as { runId: string };
    await waitForStatus(harness, runId, "running");
    const canceled = await harness.runtime.dispatchFetch("http://worker/cancel?id=" + runId, {
      method: "POST",
    });
    const result = (await canceled.json()) as {
      state: { progress: { status: string } };
      workflow: { status: string };
    };
    expect(result.state.progress.status).toBe("canceled");
    expect(result.workflow.status).toBe("terminated");
    expect(
      await harness.db
        .prepare("SELECT COUNT(*) AS count FROM analysis_leases WHERE released_at IS NULL")
        .first("count"),
    ).toBe(0);
  } finally {
    await harness.dispose();
  }
}, 30_000);
