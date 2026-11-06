import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { D1AnalysisRepository } from "@repo/db";
import {
  analysisStorage,
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

  const inputRow = (await harness.env.DB.prepare(
    "SELECT input_json,input_blob_uri FROM core_runs WHERE run_id=?",
  )
    .bind(runId)
    .first<{ input_json: string | null; input_blob_uri: string | null }>())!;
  const input =
    inputRow.input_json ??
    (await (await harness.env.BLOBS.get(inputRow.input_blob_uri!.slice("r2://".length)))!.text());
  expect(JSON.parse(input).input.kind).toBe(kind);
  if (kind === "image") {
    expect(inputRow.input_json).toBeNull();
    expect(inputRow.input_blob_uri).toMatch(/^r2:\/\/payloads\/run-inputs\//);
    expect(JSON.parse(input).input.data).toBe("data:image/png;base64,AA==");
  }
  expect(JSON.parse(input).admission).toEqual((created.params as { admission: unknown }).admission);
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
  expect(production.body.error).toBe("Analysis is not available right now.");
  expect(harness.created.length).toBe(before);
});

test("a repeated idempotency key replays the accepted run without starting another Workflow", async () => {
  const first = await start({ text: "A repeatable claim." }, "repeat-key");
  expect(first.status).toBe(202);
  const repeat = await start({ text: "A repeatable claim." }, "repeat-key");
  expect(repeat.status).toBe(202);
  expect(repeat.body).toEqual(first.body);
  expect(repeat.headers?.["x-idempotency-replayed"]).toBe("true");
  await cancelAnalysisRun(harness.env, ada, first.body.runId as string);
});

test("an uncertain Workflow creation preserves the accepted run for recovery", async () => {
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
    expect(failed.status).toBe(202);
    expect(failed.body.status).toBe("queued");
    const state = await readRunState(harness.env, grace, failed.body.runId as string);
    expect(state?.progress.status).toBe("queued");
    expect(
      await harness.env.DB.prepare("SELECT launch_status FROM core_runs WHERE run_id=?")
        .bind(failed.body.runId)
        .first("launch_status"),
    ).toBe("unknown");
    const replay = await startAnalysisRun({
      env: harness.env,
      user: grace,
      request: request(),
      body: { text: "A failing claim." },
      idempotencyKey: "failing-key",
    });
    expect(replay.status).toBe(202);
    expect(replay.body.runId).toBe(failed.body.runId);
  } finally {
    console.error = errors;
  }
});

test("launch intent is persisted before the create request is sent", async () => {
  let pending: unknown;
  const env = {
    ...harness.env,
    ANALYSIS_WORKFLOW: {
      create: async (options: Parameters<typeof harness.workflow.create>[0]) => {
        pending = await harness.env.DB.prepare("SELECT launch_status FROM core_runs WHERE run_id=?")
          .bind(options.id)
          .first("launch_status");
        return harness.workflow.create(options);
      },
    } as unknown as Workflow,
  };
  const result = await startAnalysisRun({
    env,
    user: ada,
    request: request(),
    body: { text: "A launch intent." },
    idempotencyKey: "persist-launch",
  });
  expect(result.status).toBe(202);
  expect(pending).toBe("pending");
  expect(
    await harness.env.DB.prepare("SELECT launch_status FROM core_runs WHERE run_id=?")
      .bind(result.body.runId)
      .first("launch_status"),
  ).toBe("created");
});

test("a persistence failure releases admission and remains replayable without launching", async () => {
  const create = vi
    .spyOn(D1AnalysisRepository.prototype, "createRun")
    .mockRejectedValueOnce(new Error("Persistence unavailable."));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const before = harness.created.length;
    const result = await start({ text: "An unstored claim." }, "persistence-failure", grace);
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("analysis_start_failed");
    expect(harness.created.length).toBe(before);
    const replay = await start({ text: "An unstored claim." }, "persistence-failure", grace);
    expect(replay.headers?.["x-idempotency-replayed"]).toBe("true");
    expect(replay.body.runId).toBe(result.body.runId);
  } finally {
    create.mockRestore();
    log.mockRestore();
  }
});

test("a lost persistence response resumes the stored launch instead of failing it", async () => {
  const runs = analysisStorage(harness.env).runs;
  const persist = runs.createRun.bind(runs);
  const create = vi
    .spyOn(D1AnalysisRepository.prototype, "createRun")
    .mockImplementationOnce(async (input) => {
      await persist(input);
      throw new Error("Persistence response lost.");
    });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const before = harness.created.length;
    const result = await start({ text: "A durably stored claim." }, "lost-persistence-response");
    expect(result.status).toBe(202);
    expect(harness.created.length).toBe(before + 1);
    expect(
      (await readRunState(harness.env, ada, result.body.runId as string))?.progress.status,
    ).toBe("queued");
  } finally {
    create.mockRestore();
    log.mockRestore();
  }
});

test("an unknown persistence outcome keeps admission until reconciliation or expiry", async () => {
  const create = vi
    .spyOn(D1AnalysisRepository.prototype, "createRun")
    .mockRejectedValueOnce(new Error("Persistence unavailable."));
  const read = vi
    .spyOn(D1AnalysisRepository.prototype, "getRunContext")
    .mockRejectedValueOnce(new Error("Inspection unavailable."));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await start({ text: "An uncertain claim." }, "unknown-persistence-outcome");
    expect(result.status).toBe(503);
    expect(result.body.status).toBe("unavailable");
    expect(
      await harness.env.DB.prepare(
        "SELECT released_at FROM analysis_leases WHERE idempotency_key='unknown-persistence-outcome'",
      ).first("released_at"),
    ).toBeNull();
    expect(
      await harness.env.DB.prepare(
        "SELECT request_status FROM analysis_idempotency_keys WHERE idempotency_key='unknown-persistence-outcome'",
      ).first("request_status"),
    ).toBe("in_progress");
  } finally {
    create.mockRestore();
    read.mockRestore();
    log.mockRestore();
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

test("cancellation is owner scoped, replayable, and refused after report publication", async () => {
  const queued = await start({ text: "A claim to cancel." });
  const runId = queued.body.runId as string;
  expect((await cancelAnalysisRun(harness.env, grace, runId)).status).toBe(404);
  expect(await cancelAnalysisRun(harness.env, ada, runId)).toMatchObject({
    status: 202,
    body: { status: "cancellation_requested" },
  });
  expect((await readRunState(harness.env, ada, runId))?.progress.status).toBe("canceled");
  expect((await cancelAnalysisRun(harness.env, ada, runId)).status).toBe(202);
  const finished = await seedFinishedRun(harness.env, ada.id, crypto.randomUUID());
  expect((await cancelAnalysisRun(harness.env, ada, finished.runId)).status).toBe(409);
});

test("accepted requests replay before changed runtime policy or provider availability is checked", async () => {
  const key = "replay-disabled-runtime";
  const body = { text: "A request with an accepted run." };
  const before = harness.created.length;
  const first = await start(body, key);
  const replay = await startAnalysisRun({
    env: { ...harness.env, MODE: "production", ANALYSIS_MODE: "live" },
    user: ada,
    request: request(),
    body,
    idempotencyKey: key,
  });
  expect(replay.status).toBe(202);
  expect(replay.body).toEqual(first.body);
  expect(replay.headers?.["x-idempotency-replayed"]).toBe("true");
  expect(harness.created.length).toBe(before + 1);
  const conflict = await startAnalysisRun({
    env: { ...harness.env, MODE: "production" },
    user: ada,
    request: request(),
    body: { text: "Changed input must still conflict." },
    idempotencyKey: key,
  });
  expect(conflict.status).toBe(409);
  expect(conflict.body.code).toBe("idempotency_conflict");
});
