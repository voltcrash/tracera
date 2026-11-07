import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { D1AnalysisRepository } from "@repo/db";
import { createSystemClock } from "@repo/ai/analysis";
import {
  accessScope,
  analysisStorage,
  readRunState,
  startAnalysisRun,
} from "../src/server/analysis-api.server";
import { createWorkflowAnalysisPorts } from "../src/server/analysis-runtime";
import { runAnalysisWorkflow } from "../src/server/analysis-workflow-runner.server";
import { resolveWorkflowProvider } from "../src/server/provider-selection.server";
import type { LiveExecutionPlan } from "../src/server/analysis-execution-plan";
import type { AnalysisWorkflowParams } from "../src/server/workflow-params";
import type { SessionUser } from "../src/server/session";
import { createWorkerTestEnv, ORIGIN, signIn } from "./support/worker-env";

let harness: Awaited<ReturnType<typeof createWorkerTestEnv>>;
let user: SessionUser;
beforeAll(async () => {
  harness = await createWorkerTestEnv({
    ANALYSIS_MODE: "live",
    AI_PROVIDER: "openai",
    AI_API_KEY: "execution-plan-provider-secret-canary",
    AI_BASE_URL: "https://admitted.example/v1",
    AI_MODEL: "admitted-generation",
    AI_EMBEDDING_MODEL: "admitted-embedding",
    GOOGLE_FACT_CHECK_API_KEY: "execution-plan-search-secret-canary",
    ANALYSIS_USER_CONCURRENCY_LIMIT: "20",
    ANALYSIS_IP_CONCURRENCY_LIMIT: "20",
    ANALYSIS_USER_RATE_LIMIT: "100",
    ANALYSIS_IP_RATE_LIMIT: "100",
    ANALYSIS_MAX_EXTERNAL_REQUESTS: "120",
    ANALYSIS_MAX_DISCOVERY_QUERIES_PER_CLAIM: "12",
    ANALYSIS_MAX_FETCHED_CANDIDATES_PER_CLAIM: "20",
    ANALYSIS_MAX_PROVENANCE_HOPS: "3",
    ANALYSIS_MAX_TARGETED_RETRIEVAL_ROUNDS: "2",
    ANALYSIS_MAX_ELAPSED_MS: "120000",
    ANALYSIS_MAX_CONCURRENT_EXTERNAL_CALLS: "3",
    ANALYSIS_MAX_COST_USD: "1",
    AI_DAILY_SPEND_LIMIT_USD: "25",
    AI_ESTIMATED_GENERATION_COST_USD: "0.01",
    AI_ESTIMATED_IMAGE_COST_USD: "0.02",
    AI_ESTIMATED_EMBEDDING_COST_USD: "0.0001",
  });
  user = (await signIn(harness.env, "ada")).user;
});
afterAll(async () => {
  await harness?.dispose();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await harness.env.DB.prepare("UPDATE analysis_leases SET released_at=1 WHERE user_id=?")
    .bind(user.id)
    .run();
});

async function start(env = harness.env) {
  const result = await startAnalysisRun({
    env,
    user,
    request: new Request(ORIGIN),
    body: { text: "The city opened a public library in 2026." },
    idempotencyKey: crypto.randomUUID(),
  });
  expect(result.status).toBe(202);
  const params = harness.created.at(-1)!.params as AnalysisWorkflowParams;
  const runs = analysisStorage(env).runs;
  const identity = { scope: accessScope(user), runId: params.runId };
  const context = (await runs.getRunContext(identity))!;
  const payload = (await runs.getRunInput(identity)) as { executionPlan: LiveExecutionPlan };
  return { params, runs, context, payload };
}

function steps() {
  const errors: Error[] = [];
  const step = {
    async do(_name: string, options: WorkflowStepConfig, callback: () => Promise<unknown>) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await callback();
        } catch (error) {
          errors.push(error as Error);
          if (
            (error as Error).name === "NonRetryableError" ||
            attempt >= (options.retries?.limit ?? 2)
          )
            throw error;
        }
      }
    },
  } as unknown as Pick<WorkflowStep, "do">;
  return { step, errors };
}

test("admission persists an immutable versioned plan without provider or discovery secrets", async () => {
  const { params, runs, context, payload } = await start();
  expect(payload.executionPlan).toMatchObject({
    version: 1,
    mode: "live",
    provider: {
      source: "platform",
      generation: {
        provider: "openai",
        model: "admitted-generation",
        baseUrl: "https://admitted.example/v1",
      },
      embedding: {
        provider: "openai",
        model: "admitted-embedding",
        keySource: "generation",
        dimensions: 1024,
      },
    },
    estimates: { generationCostUsd: 0.01, imageCostUsd: 0.02, embeddingCostUsd: 0.0001 },
    discovery: { googleFactCheck: true, newsApi: false },
  });
  expect(JSON.stringify(payload.executionPlan)).not.toContain("secret-canary");
  const changed = structuredClone(payload);
  changed.executionPlan.estimates.generationCostUsd = 2;
  await expect(
    runs.createRun({ context, payload: changed, launchAdmission: params.admission }),
  ).rejects.toThrow("immutable input");
});

test("models remain pinned while platform credentials may rotate on the same route", async () => {
  const { context, payload } = await start();
  const resolved = await resolveWorkflowProvider(
    {
      ...harness.env,
      AI_MODEL: "replacement-generation",
      AI_EMBEDDING_MODEL: "replacement-embedding",
      AI_API_KEY: "rotated-provider-secret-canary",
      AI_EMBEDDING_PROVIDER: "gemini",
      AI_EMBEDDING_API_KEY: "new-embedding-secret-canary",
    },
    context,
    payload.executionPlan,
  );
  expect(resolved.config).toMatchObject({
    model: "admitted-generation",
    embeddingModel: "admitted-embedding",
    apiKey: "rotated-provider-secret-canary",
    baseUrl: "https://admitted.example/v1",
  });
  expect(resolved.config.embedding).toBeUndefined();
});

test("new embedding settings cannot redirect an admitted shared-credential request", async () => {
  const { context, payload } = await start();
  const env = {
    ...harness.env,
    AI_EMBEDDING_PROVIDER: "gemini",
    AI_EMBEDDING_MODEL: "replacement",
    AI_EMBEDDING_API_KEY: "new-embedding-secret-canary",
  };
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://admitted.example/v1/embeddings");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer execution-plan-provider-secret-canary",
    );
    expect(JSON.parse(init?.body as string).model).toBe("admitted-embedding");
    return Response.json({ data: [{ embedding: Array.from({ length: 1024 }, () => 0.1) }] });
  });
  vi.stubGlobal("fetch", fetch);
  const ports = createWorkflowAnalysisPorts({
    env,
    context,
    executionPlan: payload.executionPlan,
    resolvedProvider: await resolveWorkflowProvider(env, context, payload.executionPlan),
    clock: createSystemClock(),
    blobStore: { put: async () => ({ status: "unavailable", uri: null }), read: async () => null },
    reserveUsage: async () => undefined,
  });
  await ports.embeddings.embed({ texts: ["A claim."], signal: new AbortController().signal });
  expect(fetch).toHaveBeenCalledOnce();
});

test("a changed endpoint cannot receive the current platform credential", async () => {
  const { context, payload } = await start();
  await expect(
    resolveWorkflowProvider(
      { ...harness.env, AI_BASE_URL: "https://replacement.example/v1" },
      context,
      payload.executionPlan,
    ),
  ).rejects.toThrow("execution plan");
});

test.each([
  ["0.001", 0.01],
  ["0.5", 0.5],
] as const)(
  "discovery stays pinned and cost estimates remain conservative at %s",
  async (currentCost, expectedCost) => {
    const { context, payload } = await start();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ choices: [{ message: { content: '{"answer":"ok"}' } }] })),
    );
    const env = {
      ...harness.env,
      AI_ESTIMATED_GENERATION_COST_USD: currentCost,
      NEWS_API_KEY: "new-search-secret-canary",
    };
    const reserveUsage = vi.fn(async () => undefined);
    const ports = createWorkflowAnalysisPorts({
      env,
      context,
      executionPlan: payload.executionPlan,
      resolvedProvider: await resolveWorkflowProvider(env, context, payload.executionPlan),
      clock: createSystemClock(),
      blobStore: {
        put: async () => ({ status: "unavailable", uri: null }),
        read: async () => null,
      },
      reserveUsage,
    });
    expect(ports.search.map(({ provider }) => provider)).not.toContain("news-api");
    const result = await ports.generation.generate({
      schemaName: "plan-test",
      schema: z.object({ answer: z.string() }),
      system: "Return an answer.",
      prompt: "Answer.",
      untrustedContent: [],
      images: [],
      maxOutputTokens: null,
      signal: new AbortController().signal,
    });
    expect(result.usage.costUsd).toBe(expectedCost);
    expect(reserveUsage.mock.calls).toEqual([[expectedCost]]);
  },
);

test("separate embedding credentials stay bound to their admitted route and model", async () => {
  const env = {
    ...harness.env,
    AI_EMBEDDING_PROVIDER: "openai-compatible",
    AI_EMBEDDING_API_KEY: "embedding-secret-canary",
    AI_EMBEDDING_BASE_URL: "https://embedding-admitted.example/v1",
  };
  const { context, payload } = await start(env);
  expect(payload.executionPlan.provider.embedding).toMatchObject({
    keySource: "embedding",
    provider: "openai-compatible",
  });
  expect(JSON.stringify(payload.executionPlan)).not.toContain("secret-canary");
  expect(
    (
      await resolveWorkflowProvider(
        {
          ...env,
          AI_EMBEDDING_API_KEY: "rotated-embedding-secret-canary",
          AI_EMBEDDING_MODEL: "replacement",
        },
        context,
        payload.executionPlan,
      )
    ).config.embedding,
  ).toMatchObject({
    provider: "openai-compatible",
    model: "admitted-embedding",
    baseUrl: "https://embedding-admitted.example/v1",
    apiKey: "rotated-embedding-secret-canary",
  });
  for (const changes of [
    { AI_EMBEDDING_BASE_URL: "https://replacement.example/v1" },
    { AI_EMBEDDING_PROVIDER: "gemini" },
    { AI_EMBEDDING_API_KEY: undefined },
  ])
    await expect(
      resolveWorkflowProvider({ ...env, ...changes }, context, payload.executionPlan),
    ).rejects.toThrow("execution plan");
});

test.each(["GOOGLE_FACT_CHECK_API_KEY", "AI_DAILY_SPEND_LIMIT_USD"] as const)(
  "a missing required runtime capability fails once: %s",
  async (setting) => {
    const { params } = await start();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const replay = steps();
    expect(
      await runAnalysisWorkflow({ ...harness.env, [setting]: undefined }, params, replay.step),
    ).toMatchObject({ status: "failed" });
    expect(fetch).not.toHaveBeenCalled();
    expect(replay.errors.map(({ name }) => name)).toEqual(["NonRetryableError"]);
    expect((await readRunState(harness.env, user, params.runId))?.progress).toMatchObject({
      attempt: 1,
      errorCode: "execution_plan_unavailable",
    });
  },
);

test.each(["missing", "future", "mode", "prompt", "endpoint"] as const)(
  "a persisted %s plan fails closed without provider calls",
  async (kind) => {
    const repository = analysisStorage(harness.env).runs;
    const original = repository.createRun.bind(repository);
    const create = vi.spyOn(D1AnalysisRepository.prototype, "createRun");
    create.mockImplementation((input) => {
      const payload = structuredClone(input.payload) as Record<string, unknown>;
      const context = structuredClone(input.context);
      if (kind === "missing") delete payload.executionPlan;
      else if (kind === "future") payload.executionPlan = { version: 999, mode: "live" };
      else if (kind === "mode") context.executionMode = "replay";
      else if (kind === "prompt") {
        context.versions.prompt = "unsupported-future-prompts";
        payload.executionPlan = {
          ...(payload.executionPlan as LiveExecutionPlan),
          versions: context.versions,
        };
      } else (payload.executionPlan as LiveExecutionPlan).provider.generation.baseUrl = "not-a-url";
      return original({ ...input, context, payload });
    });
    const { params } = await start();
    create.mockRestore();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const replay = steps();
    expect(await runAnalysisWorkflow(harness.env, params, replay.step)).toMatchObject({
      status: "failed",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(replay.errors.map(({ name }) => name)).toEqual(["NonRetryableError"]);
    expect((await readRunState(harness.env, user, params.runId))?.progress).toMatchObject({
      attempt: 1,
      errorCode: "execution_plan_unavailable",
    });
  },
);

test("Gemini records its supported Google route rather than an ignored base URL override", async () => {
  const env = { ...harness.env, AI_PROVIDER: "gemini", AI_BASE_URL: "https://ignored.example/v1" };
  const { context, payload } = await start(env);
  expect(payload.executionPlan.provider.generation.baseUrl).toBe(
    "https://generativelanguage.googleapis.com/v1beta",
  );
  expect(
    (
      await resolveWorkflowProvider(
        { ...env, AI_BASE_URL: "https://also-ignored.example" },
        context,
        payload.executionPlan,
      )
    ).config.provider,
  ).toBe("gemini");
});

test.each([
  ["missing", "partial"],
  ["null", "failed"],
] as const)(
  "legacy fixture plan %s has an explicit compatibility outcome",
  async (kind, expectedStatus) => {
    const repository = analysisStorage(harness.env).runs;
    const original = repository.createRun.bind(repository);
    const create = vi
      .spyOn(D1AnalysisRepository.prototype, "createRun")
      .mockImplementation((input) => {
        const payload = structuredClone(input.payload) as Record<string, unknown>;
        if (kind === "missing") delete payload.executionPlan;
        else payload.executionPlan = null;
        return original({ ...input, payload });
      });
    const { params } = await start({ ...harness.env, ANALYSIS_MODE: "fixture" });
    create.mockRestore();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const replay = steps();
    expect(await runAnalysisWorkflow(harness.env, params, replay.step)).toMatchObject({
      status: expectedStatus,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(replay.errors.map(({ name }) => name)).toEqual(
      kind === "missing" ? [] : ["NonRetryableError"],
    );
  },
);

test("transient provider failures retain bounded Workflow retries", async () => {
  const { params } = await start();
  const fetch = vi.fn(async () =>
    Response.json({ error: { message: "Unavailable" } }, { status: 503 }),
  );
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const replay = steps();
  expect(await runAnalysisWorkflow(harness.env, params, replay.step)).toMatchObject({
    status: "failed",
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(replay.errors.every(({ name }) => name !== "NonRetryableError")).toBe(true);
  expect((await readRunState(harness.env, user, params.runId))?.progress.attempt).toBe(3);
});

test("a permanent rejection survives a later progress-read failure without another provider request", async () => {
  const { params } = await start();
  let rejected = false;
  let readFailed = false;
  const fetch = vi.fn(async () => {
    rejected = true;
    return Response.json({ error: {} }, { status: 400 });
  });
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const storage = analysisStorage(harness.env);
  const read = storage.runs.getRunProgress.bind(storage.runs);
  storage.runs.getRunProgress = async (input) => {
    if (rejected && !readFailed) {
      readFailed = true;
      throw new Error("Progress temporarily unavailable");
    }
    return read(input);
  };
  const replay = steps();
  expect(await runAnalysisWorkflow(harness.env, params, replay.step, { storage })).toMatchObject({
    status: "failed",
  });
  expect(readFailed).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(replay.errors.map(({ name }) => name)).toEqual(["NonRetryableError"]);
});

test("a changed provider fails once without initializing ports or sending a request", async () => {
  const { params } = await start();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const replay = steps();
  const createPorts = vi.fn(createWorkflowAnalysisPorts);
  expect(
    await runAnalysisWorkflow({ ...harness.env, AI_PROVIDER: "gemini" }, params, replay.step, {
      createPorts,
    }),
  ).toMatchObject({ status: "failed" });
  expect(createPorts).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(replay.errors.map(({ name }) => name)).toEqual(["NonRetryableError"]);
  expect((await readRunState(harness.env, user, params.runId))?.progress).toMatchObject({
    attempt: 1,
    errorCode: "execution_plan_unavailable",
  });
});

test("a permanent provider request rejection is not retried even when the engine catches it", async () => {
  const { params } = await start();
  const fetch = vi.fn(async () =>
    Response.json({ error: { message: "execution-plan-provider-secret-canary" } }, { status: 400 }),
  );
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const replay = steps();
  expect(await runAnalysisWorkflow(harness.env, params, replay.step)).toMatchObject({
    status: "failed",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(replay.errors.map(({ name }) => name)).toEqual(["NonRetryableError"]);
  expect(JSON.stringify(replay.errors)).not.toContain("secret-canary");
  expect((await readRunState(harness.env, user, params.runId))?.progress).toMatchObject({
    attempt: 1,
    errorCode: "execution_plan_unavailable",
  });
  expect(
    await harness.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM analysis_leases WHERE user_id=? AND released_at IS NULL",
    )
      .bind(user.id)
      .first("count"),
  ).toBe(0);
});

test.each([
  "https://credential:canary@admitted.example/v1",
  "https://admitted.example/v1?key=canary",
  "http://admitted.example/v1",
  "https://admitted.example/v1?",
  "https://admitted.example/v1#",
])(
  "unsupported or credential-bearing base URL is rejected before admission: %s",
  async (baseUrl) => {
    const count = harness.created.length;
    const result = await startAnalysisRun({
      env: { ...harness.env, AI_BASE_URL: baseUrl },
      user,
      request: new Request(ORIGIN),
      body: { text: "A claim." },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(result.status).toBe(503);
    expect(harness.created).toHaveLength(count);
  },
);
