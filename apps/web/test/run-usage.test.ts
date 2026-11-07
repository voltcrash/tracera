import { afterAll, afterEach, beforeAll, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { runContextExample } from "@repo/contracts/analysis";
import { createSystemClock } from "@repo/ai/analysis";
import { analysisStorage } from "../src/server/analysis-api.server";
import { createWorkflowAnalysisPorts } from "../src/server/analysis-runtime";
import { analysisPolicy, analysisRunContext } from "../src/server/analysis-policy";
import { resolveWorkflowProvider } from "../src/server/provider-selection.server";
import { createWorkerTestEnv } from "./support/worker-env";

let harness: Awaited<ReturnType<typeof createWorkerTestEnv>>;
beforeAll(async () => {
  harness = await createWorkerTestEnv({
    ANALYSIS_MODE: "live",
    AI_PROVIDER: "openai",
    AI_API_KEY: "fixture",
    AI_MODEL: "fixture",
    AI_EMBEDDING_MODEL: "fixture",
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
});
afterAll(async () => {
  await harness?.dispose();
});
afterEach(() => vi.unstubAllGlobals());

async function setup(maxCostUsd = 1) {
  const runs = analysisStorage(harness.env).runs;
  const policy = analysisPolicy(harness.env, runContextExample.ownerUserId);
  if (!policy.enabled || policy.policy.executionPlan.mode !== "live")
    throw new Error("Live test policy is unavailable.");
  const executionPlan = policy.policy.executionPlan;
  const input = { kind: "text" as const, text: "A usage fixture." };
  const context = analysisRunContext(runContextExample.ownerUserId, input, policy.policy);
  context.budget = { ...context.budget, maxExternalRequests: 2, maxCostUsd };
  await runs.createRun({ context, payload: { input, seed: 1, executionPlan } });
  const identity = {
    scope: {
      tenantId: context.tenantId,
      ownerUserId: context.ownerUserId,
      visibility: context.visibility,
    },
    runId: context.runId,
  };
  return {
    runs,
    identity,
    portsForAttempt: async () => {
      const progress = await runs.getRunProgress(identity);
      const attempt = await runs.beginAttempt({
        ...identity,
        stage: "extract_claims",
        expectedVersion: progress!.version,
      });
      return createWorkflowAnalysisPorts({
        env: harness.env,
        context,
        executionPlan,
        resolvedProvider: await resolveWorkflowProvider(harness.env, context, executionPlan),
        clock: createSystemClock(),
        blobStore: {
          put: async () => ({ status: "unavailable", uri: null }),
          read: async () => null,
        },
        reserveUsage: async (estimatedCostUsd) => {
          if (
            !(await runs.reserveRunUsage({
              ...identity,
              fencingToken: attempt.fencingToken,
              estimatedCostUsd,
            }))
          )
            throw new Error("Run allowance exhausted.");
        },
      });
    },
  };
}

for (const limit of ["requests", "cost"] as const) {
  test(`physical provider repairs and restarted attempts share the ${limit} allowance`, async () => {
    const { runs, identity, portsForAttempt } = await setup(limit === "cost" ? 0.015 : 1);
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return Response.json({
        choices: [{ message: { content: calls === 1 ? "invalid" : '{"answer":"ok"}' } }],
      });
    });
    const request = {
      schemaName: "fixture",
      schema: z.object({ answer: z.string() }),
      system: "fixture",
      prompt: "fixture",
      untrustedContent: [],
      images: [],
      maxOutputTokens: null,
      signal: new AbortController().signal,
    };
    const first = await portsForAttempt();
    if (limit === "requests") {
      expect(await first.generation.generate(request)).toMatchObject({
        value: { answer: "ok" },
        attempts: 2,
        usage: { costUsd: 0.02 },
      });
    } else
      await expect(first.generation.generate(request)).rejects.toThrow("Run allowance exhausted.");
    const retry = await portsForAttempt();
    await expect(retry.generation.generate(request)).rejects.toThrow("Run allowance exhausted.");
    expect(calls).toBe(limit === "requests" ? 2 : 1);
    expect(await runs.getRunUsage(identity)).toMatchObject({
      externalRequests: calls,
      estimatedCostUsd: calls * 0.01,
    });
  });
}

test("public document redirects consume the same durable request allowance", async () => {
  const { runs, identity, portsForAttempt } = await setup();
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls += 1;
    return calls === 1
      ? new Response(null, { status: 302, headers: { location: "https://record.example/final" } })
      : new Response("A public record.", { headers: { "content-type": "text/plain" } });
  });
  const ports = await portsForAttempt();
  const request = {
    url: "https://record.example/start",
    role: "evidence" as const,
    maxBytes: 1000,
    signal: new AbortController().signal,
  };
  expect((await ports.documents.acquire(request)).status).toBe("complete");
  expect((await ports.documents.acquire(request)).status).toBe("partial");
  expect(calls).toBe(2);
  expect(await runs.getRunUsage(identity)).toMatchObject({
    externalRequests: 2,
    estimatedCostUsd: 0,
  });
});
