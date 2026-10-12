import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import {
  cancelAnalysisRun,
  listAnalysisRuns,
  readRunState,
  startAnalysisRun,
} from "../src/server/analysis-api.server";
import type { SessionUser } from "../src/server/session";
import { createWorkerTestEnv, ORIGIN, seedFinishedRun, signIn } from "./support/worker-env";

let harness: Awaited<ReturnType<typeof createWorkerTestEnv>>;
let ada: SessionUser;
let grace: SessionUser;
beforeAll(async () => {
  // Admission leases are released by the Workflow's last step, which these tests do not run.
  harness = await createWorkerTestEnv({
    ANALYSIS_USER_CONCURRENCY_LIMIT: "50",
    ANALYSIS_IP_CONCURRENCY_LIMIT: "50",
  });
  ada = (await signIn(harness.env, "ada")).user;
  grace = (await signIn(harness.env, "grace")).user;
});
afterAll(async () => {
  await harness?.dispose();
});

const request = () =>
  new Request(`${ORIGIN}/_serverFn/startAnalysis`, {
    headers: { "cf-connecting-ip": "203.0.113.5" },
  });
const start = (body: unknown, idempotencyKey: unknown = crypto.randomUUID(), user = ada) =>
  startAnalysisRun({ env: harness.env, user, request: request(), body, idempotencyKey });

test.each([
  ["text", { text: "A city opened a public library in 2026." }, "text"],
  ["public link", { url: "https://news.example/article" }, "link"],
  ["image", { image: "data:image/png;base64,AA==", imageMimeType: "image/png" }, "image"],
] as const)("startAnalysis queues %s input as a Workflow run", async (_label, body, kind) => {
  const result = await start(body);
  expect(result.status).toBe(202);
  const runId = result.body.runId as string;
  expect(result.body).toMatchObject({ status: "queued", reportUrl: `/run/${runId}` });
  expect(result.headers?.["x-ratelimit-limit"]).toBeDefined();

  const created = harness.created.at(-1)!;
  expect(created.id).toBe(runId);
  expect(created.params).toMatchObject({
    runId,
    ownerUserId: ada.id,
    admission: { endpoint: "startAnalysis" },
  });
  expect(JSON.stringify(created.params)).not.toMatch(/library|news\.example|base64/);

  const input = (await harness.env.DB.prepare("SELECT input_json FROM core_runs WHERE run_id=?")
    .bind(runId)
    .first<string>("input_json"))!;
  expect(JSON.parse(input).input.kind).toBe(kind);
  if (kind === "image") expect(JSON.parse(input).input.data).toBe("data:image/png;base64,AA==");
  expect((await readRunState(harness.env, ada, runId))?.progress.status).toBe("queued");
  await cancelAnalysisRun(harness.env, ada, runId);
});

test("invalid input, missing keys and disabled analysis never admit a run", async () => {
  const before = harness.created.length;
  expect((await start({ text: "x", url: "https://a.example" })).status).toBe(400);
  expect((await start({ text: "A claim." }, "")).status).toBe(400);
  const production = await startAnalysisRun({
    env: { ...harness.env, MODE: "production" },
    user: ada,
    request: request(),
    body: { text: "A claim." },
    idempotencyKey: "disabled",
  });
  expect(production.status).toBe(503);
  expect(production.body.status).toBe("unavailable");
  expect(harness.created.length).toBe(before);
});

test("a repeated idempotency key during the run is reported as in progress", async () => {
  const first = await start({ text: "A repeatable claim." }, "repeat-key");
  expect(first.status).toBe(202);
  const repeat = await start({ text: "A repeatable claim." }, "repeat-key");
  expect(repeat.status).toBe(409);
  expect(repeat.body.code).toBe("idempotency_in_progress");
  await cancelAnalysisRun(harness.env, ada, first.body.runId as string);
});

test("a Workflow creation failure fails the run and stores the failure for replay", async () => {
  const failing = {
    ...harness.env,
    ANALYSIS_WORKFLOW: {
      create: async () => {
        throw new Error("workflow unavailable");
      },
    } as unknown as Workflow,
  };
  const errors = console.error;
  console.error = () => undefined;
  try {
    const failed = await startAnalysisRun({
      env: failing,
      user: grace,
      request: request(),
      body: { text: "A failing claim." },
      idempotencyKey: "failing-key",
    });
    expect(failed.status).toBe(503);
    expect(failed.body).toMatchObject({ status: "failed", code: "analysis_start_failed" });
    const state = await readRunState(harness.env, grace, failed.body.runId as string);
    expect(state?.progress.status).toBe("failed");
    const replay = await startAnalysisRun({
      env: harness.env,
      user: grace,
      request: request(),
      body: { text: "A failing claim." },
      idempotencyKey: "failing-key",
    });
    expect(replay.headers?.["x-idempotency-replayed"]).toBe("true");
    expect(replay.body.runId).toBe(failed.body.runId);
  } finally {
    console.error = errors;
  }
});

test("run history is owner scoped and summarized", async () => {
  const report = await seedFinishedRun(harness.env, ada.id, crypto.randomUUID());
  const runs = await listAnalysisRuns(harness.env, ada);
  expect(runs.find(({ runId }) => runId === report.runId)).toMatchObject({
    headline: report.claims[0]!.text,
    score: report.scorecard!.factualScore,
    status: "complete",
  });
  expect(
    (await listAnalysisRuns(harness.env, grace)).some(({ runId }) => runId === report.runId),
  ).toBe(false);
});

test("finished runs return their report only to their owner", async () => {
  const report = await seedFinishedRun(harness.env, ada.id, crypto.randomUUID());
  const state = await readRunState(harness.env, ada, report.runId);
  expect(state?.progress).toMatchObject({ status: "complete", currentStage: null });
  expect(state?.report?.runId).toBe(report.runId);
  expect(await readRunState(harness.env, grace, report.runId)).toBeNull();
});

test("cancellation is owner scoped and refused once a run has finished", async () => {
  const queued = await start({ text: "A claim to cancel." });
  const runId = queued.body.runId as string;
  expect((await cancelAnalysisRun(harness.env, grace, runId)).status).toBe(404);
  expect(await cancelAnalysisRun(harness.env, ada, runId)).toMatchObject({
    status: 202,
    body: { status: "cancellation_requested" },
  });
  expect((await readRunState(harness.env, ada, runId))?.progress.status).toBe("canceled");
  expect((await cancelAnalysisRun(harness.env, ada, runId)).status).toBe(409);
});
