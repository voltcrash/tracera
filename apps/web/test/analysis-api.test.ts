import assert from "node:assert/strict";
import type { RunAnalysisV2Result } from "@repo/ai/core/types";
import { coreV2Examples, runReportSchema, type RunReport } from "@repo/contracts/core-v2";
import { test } from "vite-plus/test";
import type { AuthUser } from "@repo/db";
import type { CoreRunProgress } from "@repo/db/core/repository";
import { createAnalysisApp, type AnalysisDependencies } from "../src/server/analysis";
import {
  focusedRuntimePolicy,
  type CoreRuntimeRepository,
  type FocusedRunExecutionInput,
} from "../src/server/analysis-runtime";
import { app, type Bindings } from "../src/server/index";

test("analysis routes mount without a version prefix", () => {
  assert.ok(app.routes.some(({ path }) => path === "/analyze"));
  assert.ok(app.routes.some(({ path }) => path === "/runs"));
  assert.ok(app.routes.every(({ path }) => !path.startsWith("/v2/")));
});

const env = {
  TRACERA_PROFILE: "test",
  TRACERA_CONFIG_ROLE: "runtime",
  TRACERA_ANALYSIS_MODE: "fixture",
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
} satisfies Bindings;

function createHarness(execute: (input: FocusedRunExecutionInput) => Promise<RunAnalysisV2Result>) {
  let savedResponse: { body: unknown; status: number } | null = null;
  let executions = 0;
  const progress = new Map<string, CoreRunProgress>();
  const reports = new Map<string, RunReport>();
  const repository = {
    enqueue: async () => ({ jobId: "job", created: true }),
    acquireLease: async () => null,
    renewLease: async () => "",
    retry: async () => ({ terminal: true }),
    requestCancellation: async () => false,
    acknowledgeCancellation: async () => undefined,
    getRunProgress: async ({ runId, scope }: { runId: string; scope: { ownerUserId: string } }) =>
      scope.ownerUserId === "ada" ? (progress.get(runId) ?? null) : null,
    listRuns: async ({ scope }: { scope: { ownerUserId: string } }) =>
      scope.ownerUserId === "ada"
        ? [...reports.entries()].map(([runId, report]) => ({
            runId,
            status: report.status,
            createdAt: report.createdAt,
            report,
          }))
        : [],
    getLatestReport: async ({ runId, scope }: { runId: string; scope: { ownerUserId: string } }) =>
      scope.ownerUserId === "ada" ? (reports.get(runId) ?? null) : null,
    checkpoint: async () => undefined,
    readCheckpoint: async () => null,
    finalize: async ({ runId, report }: { runId: string; report: RunReport }) => {
      reports.set(runId, report);
    },
    putSnapshot: async () => undefined,
    getSnapshot: async () => null,
    getSnapshots: async () => [],
  } as unknown as CoreRuntimeRepository;
  const authenticate = async (request: Request): Promise<AuthUser | null> => {
    const id = request.headers.get("x-test-user");
    return id ? { id, email: `${id}@test.example`, createdAt: "2026-09-15T00:00:00.000Z" } : null;
  };
  const dependencies: AnalysisDependencies = {
    repository,
    authenticate,
    admit: async () => {
      if (savedResponse) {
        return {
          kind: "replay",
          responseBody: savedResponse.body,
          responseStatus: savedResponse.status,
        };
      }
      return {
        kind: "admitted",
        leaseId: `lease-${executions + 1}`,
        userRateLimit: {
          limit: 30,
          remaining: 29,
          resetAt: "2026-09-16T00:00:00.000Z",
        },
        ipRateLimit: {
          limit: 60,
          remaining: 59,
          resetAt: "2026-09-16T00:00:00.000Z",
        },
      };
    },
    finish: async ({ responseBody, responseStatus }) => {
      savedResponse = { body: responseBody, status: responseStatus };
    },
    execute: async (input) => {
      executions += 1;
      return execute(input);
    },
  };
  return {
    app: createAnalysisApp(dependencies),
    repository,
    progress,
    reports,
    get executions() {
      return executions;
    },
  };
}

function completeResult(input: FocusedRunExecutionInput) {
  const report = reportFor(input, "complete");
  return {
    status: "complete" as const,
    report,
    issues: report.unresolvedReasons,
    replayManifest: report.replayManifest,
    cost: report.cost,
  };
}

function reportFor(
  input: FocusedRunExecutionInput,
  status: "complete" | "partial" | "unavailable" | "failed",
  issueCode?: "provider_failure" | "content_unavailable" | "timeout" | "budget_exhausted",
) {
  const source =
    status === "complete"
      ? coreV2Examples.complete
      : status === "partial"
        ? coreV2Examples.partial
        : coreV2Examples.unavailable;
  const report = structuredClone(source);
  report.runId = input.context.runId;
  report.createdAt = input.context.asOfTime;
  report.asOfTime = input.context.asOfTime;
  report.visibility = input.context.visibility;
  report.status = status;
  report.replayManifest = {
    ...report.replayManifest,
    runId: input.context.runId,
    versions: input.context.versions,
    asOfTime: input.context.asOfTime,
    inputHash: input.context.inputHash,
    budget: input.context.budget,
  };
  if (issueCode) {
    const issue = {
      code: issueCode,
      severity: "error" as const,
      message: `Tested ${issueCode} outcome.`,
      claimId: null,
      snapshotId: null,
      url: null,
    };
    report.unresolvedReasons = [...report.unresolvedReasons, issue];
    report.stageOutcomes[0] = {
      ...report.stageOutcomes[0]!,
      issues: [...report.stageOutcomes[0]!.issues, issue],
    };
  }
  return runReportSchema.parse(report);
}

async function submit(
  app: ReturnType<typeof createAnalysisApp>,
  body: Record<string, unknown>,
  user = "ada",
  key = crypto.randomUUID(),
) {
  return app.request(
    "/analyze",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-test-user": user,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

for (const [label, body, kind] of [
  ["text", { text: "A city opened a public library in 2026." }, "text"],
  ["public link", { url: "https://news.example/article" }, "link"],
  ["image", { image: "data:image/png;base64,AA==", imageMimeType: "image/png" }, "image"],
] as const) {
  test(`focused API accepts ${label} input`, async () => {
    let receivedKind: string | undefined;
    const harness = createHarness(async (input) => {
      receivedKind = input.analysis.input.kind;
      return completeResult(input);
    });
    const response = await submit(harness.app, body);
    const payload = (await response.json()) as { status: string; report?: RunReport };

    assert.equal(response.status, 200);
    assert.equal(receivedKind, kind);
    assert.equal(payload.status, "complete");
    assert.equal(payload.report?.status, "complete");
    assert.equal(harness.executions, 1);
  });
}

test("provider failure, unavailable article, partial OCR, timeout, and budget exhaustion stay explicit", async () => {
  const cases = [
    ["provider failure", "failed", "provider_failure"],
    ["unavailable article", "unavailable", "content_unavailable"],
    ["partial OCR", "partial", undefined],
    ["timeout", "unavailable", "timeout"],
    ["budget exhaustion", "unavailable", "budget_exhausted"],
  ] as const;
  for (const [label, status, issueCode] of cases) {
    const harness = createHarness(async (input) => {
      const report = reportFor(input, status, issueCode);
      return {
        status,
        report,
        issues: report.unresolvedReasons,
        replayManifest: report.replayManifest,
        cost: report.cost,
      };
    });
    const response = await submit(harness.app, { text: `test ${label}` });
    const payload = (await response.json()) as { status: string; report?: RunReport };

    assert.equal(response.status, 200, label);
    assert.equal(payload.status, status, label);
    assert.equal(payload.report?.status, status, label);
    assert.notEqual(payload.status, "complete", label);
    if (issueCode)
      assert.ok(payload.report?.unresolvedReasons.some((item) => item.code === issueCode));
  }
});

test("authentication is required before focused analysis starts", async () => {
  const harness = createHarness(async (input) => completeResult(input));
  const response = await harness.app.request(
    "/analyze",
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "auth-test" },
      body: JSON.stringify({ text: "A claim to check." }),
    },
    env,
  );

  assert.equal(response.status, 401);
  assert.equal(harness.executions, 0);
});

test("focused run history is owner scoped and summarized", async () => {
  const harness = createHarness(async (input) => completeResult(input));
  const report = structuredClone(coreV2Examples.complete);
  report.runId = "run-history";
  harness.reports.set(report.runId, report);

  const response = await harness.app.request("/runs", { headers: { "x-test-user": "ada" } }, env);
  const payload = (await response.json()) as {
    runs: Array<{ runId: string; headline: string; score: number | null }>;
  };
  assert.equal(response.status, 200);
  assert.deepEqual(payload.runs, [
    {
      runId: "run-history",
      headline: report.claims[0]!.text,
      score: report.scorecard!.factualScore,
      status: report.status,
      createdAt: report.createdAt,
    },
  ]);

  const otherOwner = await harness.app.request(
    "/runs",
    { headers: { "x-test-user": "grace" } },
    env,
  );
  assert.deepEqual(await otherOwner.json(), { schemaVersion: 2, runs: [] });
});

test("owner isolation applies to saved focused runs", async () => {
  const harness = createHarness(async (input) => completeResult(input));
  const progress: CoreRunProgress = {
    runId: "run-owned-by-ada",
    status: "complete",
    stage: "score_report",
    attempt: 1,
    cancellationRequested: false,
    leaseExpiresAt: null,
    completedStages: [
      "normalize_input",
      "extract_claims",
      "retrieve_evidence",
      "assess_evidence",
      "trace_origins",
      "adjudicate_claims",
      "calibrate_decisions",
      "score_report",
    ],
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
  harness.progress.set(progress.runId, progress);
  const owner = await harness.app.request(
    `/runs/${progress.runId}`,
    { headers: { "x-test-user": "ada" } },
    env,
  );
  const otherUser = await harness.app.request(
    `/runs/${progress.runId}`,
    { headers: { "x-test-user": "grace" } },
    env,
  );

  assert.equal(owner.status, 200);
  assert.equal(otherUser.status, 404);
});

test("repeat submission with one idempotency key replays the saved focused response", async () => {
  const harness = createHarness(async (input) => completeResult(input));
  const key = "repeat-focused-request";
  const first = await submit(harness.app, { text: "A repeatable claim." }, "ada", key);
  const firstPayload = (await first.json()) as { runId: string };
  const replay = await submit(harness.app, { text: "A repeatable claim." }, "ada", key);
  const replayPayload = (await replay.json()) as { runId: string };

  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("x-idempotency-replayed"), "true");
  assert.equal(replayPayload.runId, firstPayload.runId);
  assert.equal(harness.executions, 1);
});

test("an executor failure returns failed without a completed focused report", async () => {
  const harness = createHarness(async () => {
    throw new Error("configured provider failed");
  });
  const response = await submit(harness.app, { text: "A provider failure claim." });
  const payload = (await response.json()) as { status: string; report?: unknown };

  assert.equal(response.status, 503);
  assert.equal(payload.status, "failed");
  assert.equal(payload.report, undefined);
  assert.equal(harness.executions, 1);
});

test("deployed focused policy requires explicit live provider and budget settings", () => {
  const provider = {
    TRACERA_PROFILE: "deployed",
    TRACERA_ANALYSIS_MODE: "live",
    AI_PROVIDER: "openai",
    AI_API_KEY: "configured",
    AI_MODEL: "configured-model",
    AI_EMBEDDING_MODEL: "configured-embedding-model",
  };
  const budget = {
    CORE_V2_MAX_EXTERNAL_REQUESTS: "120",
    CORE_V2_MAX_DISCOVERY_QUERIES_PER_CLAIM: "12",
    CORE_V2_MAX_FETCHED_CANDIDATES_PER_CLAIM: "20",
    CORE_V2_MAX_PROVENANCE_HOPS: "3",
    CORE_V2_MAX_TARGETED_RETRIEVAL_ROUNDS: "2",
    CORE_V2_MAX_ELAPSED_MS: "120000",
    CORE_V2_MAX_CONCURRENT_EXTERNAL_CALLS: "3",
    CORE_V2_MAX_COST_USD: "1.00",
  };
  const spend = {
    AI_DAILY_SPEND_LIMIT_USD: "25",
    AI_ESTIMATED_GENERATION_COST_USD: "0.01",
    AI_ESTIMATED_IMAGE_COST_USD: "0.02",
    AI_ESTIMATED_EMBEDDING_COST_USD: "0.0001",
  };
  const missing = focusedRuntimePolicy(provider);
  assert.equal(missing.enabled, false);
  const missingSpend = focusedRuntimePolicy({ ...provider, ...budget });
  assert.equal(missingSpend.enabled, false);

  const enabled = focusedRuntimePolicy({ ...provider, ...budget, ...spend });
  assert.equal(enabled.enabled, true);
  if (enabled.enabled) {
    assert.equal(enabled.policy.mode, "live");
    assert.equal(enabled.policy.providerConfig?.model, "configured-model");
    assert.equal(enabled.policy.budget.maxCostUsd, 1);
  }
});

test("deterministic focused fixtures are limited to the test profile", () => {
  const testPolicy = focusedRuntimePolicy({
    TRACERA_PROFILE: "test",
    TRACERA_ANALYSIS_MODE: "fixture",
  });
  const deployedFixture = focusedRuntimePolicy({
    TRACERA_PROFILE: "deployed",
    TRACERA_ANALYSIS_MODE: "fixture",
  });
  const unknownMode = focusedRuntimePolicy({
    TRACERA_PROFILE: "deployed",
    TRACERA_ANALYSIS_MODE: "shadow",
  });

  assert.equal(testPolicy.enabled, true);
  assert.equal(deployedFixture.enabled, false);
  assert.equal(unknownMode.enabled, false);
});
