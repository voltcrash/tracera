import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vite-plus/test";
import {
  accessScope,
  analysisStorage,
  readRunState,
  startAnalysisRun,
} from "../src/server/analysis-api.server";
import { runAnalysisWorkflow } from "../src/server/analysis-workflow-runner.server";
import { providerKeyStorage, saveProviderKeyForUser } from "../src/server/provider-keys.server";
import { resolveWorkflowProvider } from "../src/server/provider-selection.server";
import { createWorkerTestEnv, ORIGIN, signIn } from "./support/worker-env";
import type { SessionUser } from "../src/server/session";
import type { AnalysisWorkflowParams } from "../src/server/workflow-params";

const secret = "personal-workflow-secret-canary";
let harness: Awaited<ReturnType<typeof createWorkerTestEnv>>;
let user: SessionUser;
beforeAll(async () => {
  harness = await createWorkerTestEnv({
    ANALYSIS_MODE: "live",
    PROVIDER_KEYS_ENCRYPTION_KEY: JSON.stringify({
      activeVersion: 1,
      keys: { 1: btoa("x".repeat(32)) },
    }),
    ANALYSIS_MAX_EXTERNAL_REQUESTS: "120",
    ANALYSIS_MAX_DISCOVERY_QUERIES_PER_CLAIM: "12",
    ANALYSIS_MAX_FETCHED_CANDIDATES_PER_CLAIM: "20",
    ANALYSIS_MAX_PROVENANCE_HOPS: "3",
    ANALYSIS_MAX_TARGETED_RETRIEVAL_ROUNDS: "2",
    ANALYSIS_MAX_ELAPSED_MS: "120000",
    ANALYSIS_MAX_CONCURRENT_EXTERNAL_CALLS: "3",
    ANALYSIS_MAX_COST_USD: "1",
    AI_ESTIMATED_GENERATION_COST_USD: "0.01",
    AI_ESTIMATED_IMAGE_COST_USD: "0.02",
    AI_ESTIMATED_EMBEDDING_COST_USD: "0.0001",
  });
  user = (await signIn(harness.env, "ada")).user;
});
beforeEach(async () => {
  await saveProviderKeyForUser(
    harness.env,
    user.id,
    {
      provider: "openai",
      apiKey: secret,
      model: "personal-model",
      embeddingModel: "personal-embedding",
    },
    async () => undefined,
  );
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
async function start() {
  const result = await startAnalysisRun({
    env: harness.env,
    user,
    request: new Request(ORIGIN),
    body: { text: "The city opened a public library in 2026." },
    idempotencyKey: crypto.randomUUID(),
  });
  expect(result.status).toBe(202);
  return harness.created.at(-1)!.params as AnalysisWorkflowParams;
}

test("workflow provider resolution decrypts only the owner's selected key and records use", async () => {
  const params = await start();
  const context = (await analysisStorage(harness.env).runs.getRunContext({
    scope: accessScope(user),
    runId: params.runId,
  }))!;
  expect((await providerKeyStorage(harness.env).activeMetadata(user.id))?.lastUsedAt).toBeNull();
  expect(await resolveWorkflowProvider(harness.env, context)).toMatchObject({
    source: "user",
    config: { apiKey: secret },
  });
  expect(
    (await providerKeyStorage(harness.env).activeMetadata(user.id))?.lastUsedAt,
  ).toBeInstanceOf(Date);
  await harness.env.DB.prepare("UPDATE analysis_leases SET released_at=1 WHERE id=?")
    .bind(params.admission.leaseId)
    .run();
});

test("rejected personal keys fail without retries, platform spend, or secret persistence", async () => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: { message: secret } }, { status: 401 })),
  );
  const params = await start();
  const errors: string[] = [];
  const step = {
    async do(_name: string, _options: WorkflowStepConfig, callback: () => Promise<unknown>) {
      try {
        return await callback();
      } catch (error) {
        errors.push(String(error));
        throw error;
      }
    },
  } as unknown as Pick<WorkflowStep, "do">;
  expect(await runAnalysisWorkflow(harness.env, params, step)).toMatchObject({ status: "failed" });
  expect(errors).toEqual([expect.stringContaining("Your key was rejected")]);
  expect(JSON.stringify(errors)).not.toContain(secret);
  expect((await readRunState(harness.env, user, params.runId))?.progress).toMatchObject({
    status: "failed",
    attempt: 1,
    errorCode: "provider_key_rejected",
  });
  expect(
    await harness.env.DB.prepare("SELECT COUNT(*) AS count FROM ai_provider_spend").first("count"),
  ).toBe(0);
  expect(
    await harness.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM analysis_leases WHERE released_at IS NULL",
    ).first("count"),
  ).toBe(0);
  expect(
    await harness.env.DB.prepare("SELECT last_error FROM core_runs WHERE run_id=?")
      .bind(params.runId)
      .first("last_error"),
  ).toBe("provider_key_rejected");
  expect((await providerKeyStorage(harness.env).activeMetadata(user.id))?.health).toBe("rejected");
  expect(
    await startAnalysisRun({
      env: harness.env,
      user,
      request: new Request(ORIGIN),
      body: { text: "A new claim." },
      idempotencyKey: crypto.randomUUID(),
    }),
  ).toMatchObject({ status: 503 });
});

test("replacing a provider key and endpoints does not alter an admitted run", async () => {
  expect(
    await saveProviderKeyForUser(
      harness.env,
      user.id,
      {
        provider: "openai-compatible",
        apiKey: secret,
        model: "personal-model",
        embeddingModel: "personal-embedding",
        baseUrl: "https://original.example/v1",
      },
      async () => undefined,
    ),
  ).toEqual({ ok: true });
  const params = await start();
  const context = (await analysisStorage(harness.env).runs.getRunContext({
    scope: accessScope(user),
    runId: params.runId,
  }))!;
  expect(
    await saveProviderKeyForUser(
      harness.env,
      user.id,
      {
        provider: "openai-compatible",
        apiKey: "replacement-secret",
        model: "personal-model",
        embeddingModel: "personal-embedding",
        baseUrl: "https://replacement.example/v1",
        embeddingProvider: "openai-compatible",
        embeddingBaseUrl: "https://embedding.example/v1",
        embeddingApiKey: "replacement-embedding-secret",
      },
      async () => undefined,
    ),
  ).toEqual({ ok: true });
  const resolved = await resolveWorkflowProvider(harness.env, context);
  expect(resolved.config.apiKey).toBe(secret);
  expect(resolved.config.baseUrl).toBe("https://original.example/v1");
  expect(resolved.config.embedding).toBeUndefined();
});

test("switching the active provider affects new runs without invalidating an admitted run", async () => {
  const params = await start();
  const context = (await analysisStorage(harness.env).runs.getRunContext({
    scope: accessScope(user),
    runId: params.runId,
  }))!;
  await saveProviderKeyForUser(
    harness.env,
    user.id,
    {
      provider: "gemini",
      apiKey: "gemini-secret",
      model: "gemini-model",
      embeddingModel: "gemini-embedding",
    },
    async () => undefined,
  );
  expect((await resolveWorkflowProvider(harness.env, context)).config.apiKey).toBe(secret);
});

test("deleting a key revokes further physical request admission for its run", async () => {
  const params = await start();
  const runs = analysisStorage(harness.env).runs;
  const identity = { scope: accessScope(user), runId: params.runId };
  const attempt = await runs.beginAttempt({
    ...identity,
    stage: "normalize_input",
    expectedVersion: 0,
  });
  const request = { ...identity, fencingToken: attempt.fencingToken, estimatedCostUsd: 0.01 };
  expect(await runs.reserveRunUsage(request)).toBe(true);
  await providerKeyStorage(harness.env).delete(user.id, "openai");
  expect(await runs.reserveRunUsage(request)).toBe(false);
  expect((await runs.getRunUsage(identity))?.externalRequests).toBe(1);
});

test("legacy user-provider contexts without a revision fail closed", async () => {
  const params = await start();
  const context = (await analysisStorage(harness.env).runs.getRunContext({
    scope: accessScope(user),
    runId: params.runId,
  }))!;
  context.provider = { source: "user", provider: "openai" };
  await expect(resolveWorkflowProvider(harness.env, context)).rejects.toThrow("revision");
});

test("a deleted queued revision fails without initializing provider ports or retrying analysis", async () => {
  const params = await start();
  await providerKeyStorage(harness.env).delete(user.id, "openai");
  const createPorts = vi.fn(() => {
    throw new Error("Provider ports must not be created");
  });
  const errors: Error[] = [];
  const step = {
    async do(_name: string, _options: unknown, callback: () => Promise<unknown>) {
      try {
        return await callback();
      } catch (error) {
        errors.push(error as Error);
        throw error;
      }
    },
  } as unknown as Pick<WorkflowStep, "do">;
  expect((await runAnalysisWorkflow(harness.env, params, step, { createPorts })).status).toBe(
    "failed",
  );
  expect(createPorts).not.toHaveBeenCalled();
  expect(errors.map(({ name }) => name)).toEqual(["NonRetryableError"]);
  expect((await readRunState(harness.env, user, params.runId))?.progress).toMatchObject({
    attempt: 1,
    errorCode: "provider_revision_unavailable",
  });
});

test("revocation before a physical call stays terminal even when the engine catches its error", async () => {
  const params = await start();
  const fetch = vi.fn(async () => {
    throw new Error("No external call should be made");
  });
  vi.stubGlobal("fetch", fetch);
  const { createWorkflowAnalysisPorts } = await import("../src/server/analysis-runtime");
  const createPorts: typeof createWorkflowAnalysisPorts = (input) => {
    const ports = createWorkflowAnalysisPorts(input);
    const generate = ports.generation.generate.bind(ports.generation);
    ports.generation.generate = async (request) => {
      await providerKeyStorage(harness.env).delete(user.id, "openai");
      return generate(request);
    };
    return ports;
  };
  const step = {
    async do(_name: string, _options: unknown, callback: () => Promise<unknown>) {
      return callback();
    },
  } as unknown as Pick<WorkflowStep, "do">;
  expect((await runAnalysisWorkflow(harness.env, params, step, { createPorts })).status).toBe(
    "failed",
  );
  expect(fetch).not.toHaveBeenCalled();
  const storage = analysisStorage(harness.env);
  expect(
    (await storage.runs.getRunUsage({ scope: accessScope(user), runId: params.runId }))
      ?.externalRequests,
  ).toBe(0);
  expect((await readRunState(harness.env, user, params.runId))?.progress).toMatchObject({
    attempt: 1,
    errorCode: "provider_revision_unavailable",
  });
});

test("an old revision rejection cannot poison a replacement saved during its request", async () => {
  const params = await start();
  const original = (await providerKeyStorage(harness.env).activeMetadata(user.id))!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: { message: secret } }, { status: 401 })),
  );
  const { createWorkflowAnalysisPorts } = await import("../src/server/analysis-runtime");
  const createPorts: typeof createWorkflowAnalysisPorts = (input) => {
    const ports = createWorkflowAnalysisPorts(input);
    const generate = ports.generation.generate.bind(ports.generation);
    ports.generation.generate = async (request) => {
      expect(
        await saveProviderKeyForUser(
          harness.env,
          user.id,
          {
            provider: "openai",
            apiKey: "replacement-secret",
            model: "personal-model",
            embeddingModel: "personal-embedding",
          },
          async () => undefined,
        ),
      ).toEqual({ ok: true });
      return generate(request);
    };
    return ports;
  };
  const step = {
    async do(_name: string, _options: unknown, callback: () => Promise<unknown>) {
      return callback();
    },
  } as unknown as Pick<WorkflowStep, "do">;
  expect((await runAnalysisWorkflow(harness.env, params, step, { createPorts })).status).toBe(
    "failed",
  );
  const current = (await providerKeyStorage(harness.env).activeMetadata(user.id))!;
  expect(current.id).not.toBe(original.id);
  expect(current.health).toBe("verified");
  expect((await providerKeyStorage(harness.env).revision(user.id, original.id))?.health).toBe(
    "rejected",
  );
});

test("a deleted user key never silently switches an admitted run to a platform key", async () => {
  const params = await start();
  const context = (await analysisStorage(harness.env).runs.getRunContext({
    scope: accessScope(user),
    runId: params.runId,
  }))!;
  await providerKeyStorage(harness.env).delete(user.id, "openai");
  await expect(
    resolveWorkflowProvider(
      {
        ...harness.env,
        AI_PROVIDER: "openai",
        AI_API_KEY: "platform-secret",
        AI_MODEL: "personal-model",
        AI_EMBEDDING_MODEL: "personal-embedding",
      },
      context,
    ),
  ).rejects.toThrow("provider key revision is unavailable");
});
