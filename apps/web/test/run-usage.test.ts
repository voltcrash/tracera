import { afterAll, afterEach, beforeAll, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { runContextExample, type RunContext } from "@repo/contracts/analysis";
import { createSystemClock } from "@repo/ai/analysis";
import { analysisStorage } from "../src/server/analysis-api.server";
import { createWorkflowAnalysisPorts } from "../src/server/analysis-runtime";
import { createWorkerTestEnv } from "./support/worker-env";

let harness: Awaited<ReturnType<typeof createWorkerTestEnv>>;
beforeAll(async () => {
  harness = await createWorkerTestEnv({
    ANALYSIS_MODE: "live",
    AI_PROVIDER: "openai",
    AI_API_KEY: "fixture",
    AI_MODEL: "fixture",
    AI_EMBEDDING_MODEL: "fixture",
  });
});
afterAll(async () => {
  await harness?.dispose();
});
afterEach(() => vi.unstubAllGlobals());

async function setup(maxCostUsd = 1) {
  const runs = analysisStorage(harness.env).runs;
  const context: RunContext = {
    ...structuredClone(runContextExample),
    runId: crypto.randomUUID(),
    executionMode: "live",
    provider: { source: "platform", provider: "openai" },
  };
  context.versions.model = "fixture";
  context.versions.embedding.model = "fixture";
  context.budget = { ...context.budget, maxExternalRequests: 2, maxCostUsd };
  await runs.createRun({ context });
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
