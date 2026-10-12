import { runReportSchema, stageNameSchema } from "@repo/contracts/analysis";
import type { AnalysisAccessScope } from "@repo/db/analysis/repository";
import {
  createD1AdmissionRepository,
  createD1AnalysisRepository,
  type D1RepositoryOptions,
} from "@repo/db/d1";
import {
  admitAnalysis,
  analysisAdmissionError,
  analysisControlConfig,
  analysisControlHeaders,
  analysisControlPayload,
  analysisControlStatus,
  analysisRateHeaders,
  validIdempotencyKey,
} from "./analysis-controls";
import { parseFirstPartyAnalysisInput, type FirstPartyAnalysisInput } from "./analysis-input";
import { analysisPolicy, analysisRunContext } from "./analysis-policy";
import type { ServerEnv } from "./env";
import { logServerError } from "./error-handling";
import type { SessionUser } from "./session";
import type { AnalysisWorkflowParams } from "./workflow-params";

export const START_ANALYSIS_ENDPOINT = "startAnalysis";
export const ANALYSIS_SEED = 20260910;

export type ApiResult = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

const TERMINAL = new Set(["complete", "partial", "unavailable", "failed", "canceled"]);

export function analysisStorage(env: ServerEnv) {
  // Wrangler's generated runtime types and @cloudflare/workers-types describe the same bindings.
  const options = { database: env.DB, bucket: env.BLOBS } as unknown as D1RepositoryOptions;
  return {
    runs: createD1AnalysisRepository(options),
    admission: createD1AdmissionRepository(options),
  };
}

export function accessScope(user: Pick<SessionUser, "id">): AnalysisAccessScope {
  return { tenantId: `user:${user.id}`, ownerUserId: user.id, visibility: "private" };
}

export async function startAnalysisRun(input: {
  env: ServerEnv;
  user: SessionUser;
  request: Request;
  body: unknown;
  idempotencyKey: unknown;
}): Promise<ApiResult> {
  const { env, user, request } = input;
  const parsed = parseFirstPartyAnalysisInput(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error } };
  const runtime = analysisPolicy(env, user.id);
  if (!runtime.enabled)
    return {
      status: 503,
      body: { schemaVersion: 2, status: "unavailable", code: runtime.code, error: runtime.message },
    };
  const idempotency = validIdempotencyKey(input.idempotencyKey);
  if (!idempotency.valid) return { status: 400, body: { error: idempotency.message } };

  const storage = analysisStorage(env);
  const config = analysisControlConfig(env);
  let admission: Awaited<ReturnType<typeof admitAnalysis>>;
  try {
    admission = await admitAnalysis({
      userId: user.id,
      request,
      endpoint: START_ANALYSIS_ENDPOINT,
      body: parsed.data,
      idempotencyKey: idempotency.value,
      forceReanalysis: parsed.data.forceReanalysis === true,
      config,
      secret: env.BETTER_AUTH_SECRET,
      store: storage.admission,
    });
  } catch {
    return { status: 503, body: { error: "Analysis controls are unavailable." } };
  }
  if (admission.kind === "rejected") {
    const error = analysisAdmissionError(admission);
    return {
      status: analysisControlStatus(error.code),
      body: analysisControlPayload(error),
      headers: analysisControlHeaders(error),
    };
  }
  if (admission.kind === "replay")
    return {
      status: admission.responseStatus,
      body: admission.responseBody as Record<string, unknown>,
      headers: { "x-idempotency-replayed": "true" },
    };

  const context = analysisRunContext(user.id, analysisInput(parsed.data), runtime.policy);
  const params: AnalysisWorkflowParams = {
    runId: context.runId,
    ownerUserId: user.id,
    admission: {
      endpoint: START_ANALYSIS_ENDPOINT,
      idempotencyKey: idempotency.value,
      leaseId: admission.leaseId,
    },
  };
  try {
    await storage.runs.createRun({
      context,
      payload: { input: analysisInput(parsed.data), seed: ANALYSIS_SEED },
    });
    await env.ANALYSIS_WORKFLOW.create({ id: context.runId, params });
  } catch (error) {
    logServerError("Analysis could not start", error, request);
    const failure = {
      schemaVersion: 2,
      runId: context.runId,
      status: "failed",
      code: "analysis_start_failed",
      error: "The analysis could not be started. Please try again.",
    };
    await storage.runs
      .failRun({
        scope: accessScope(user),
        runId: context.runId,
        fencingToken: null,
        error: "The analysis workflow could not be created.",
      })
      .catch(() => undefined);
    await storage.admission
      .finishAnalysisAdmission({
        userId: user.id,
        ...params.admission,
        responseBody: failure,
        responseStatus: 503,
        idempotencyTtlSeconds: config.idempotencyTtlSeconds,
      })
      .catch(() => undefined);
    return { status: 503, body: failure, headers: analysisRateHeaders(admission) };
  }
  return {
    status: 202,
    body: {
      schemaVersion: 2,
      engineVersion: context.versions.engine,
      runId: context.runId,
      status: "queued",
      eventsUrl: `/api/runs/${context.runId}/events`,
      reportUrl: `/run/${context.runId}`,
    },
    headers: analysisRateHeaders(admission),
  };
}

export async function listAnalysisRuns(env: ServerEnv, user: SessionUser) {
  const runs = await analysisStorage(env).runs.listRuns({ scope: accessScope(user), limit: 30 });
  return runs.map(({ runId, status, createdAt, report }) => ({
    runId,
    status,
    createdAt,
    headline:
      report?.claims.find(
        ({ duplicateOfClaimId, coverageDisposition }) =>
          duplicateOfClaimId === null && coverageDisposition !== "deferred",
      )?.text ??
      report?.claims.find(({ duplicateOfClaimId }) => duplicateOfClaimId === null)?.text ??
      "Focused analysis",
    score: report?.scorecard?.factualScore ?? null,
  }));
}

export async function readRunState(env: ServerEnv, user: SessionUser, runId: string) {
  const runs = analysisStorage(env).runs;
  const scope = accessScope(user);
  const progress = await runs.getRunProgress({ scope, runId });
  if (!progress) return null;
  const terminal = TERMINAL.has(progress.status);
  const report =
    terminal && progress.status !== "canceled"
      ? await runs.getLatestReport({ scope, runId })
      : null;
  const completed = new Set(progress.completedStages);
  const currentStage = terminal
    ? null
    : (stageNameSchema.options.find((stage) => !completed.has(stage)) ?? null);
  return {
    progress: { ...progress, currentStage },
    report: report ? runReportSchema.parse(report) : null,
  };
}

export type RunState = NonNullable<Awaited<ReturnType<typeof readRunState>>>;

export async function cancelAnalysisRun(
  env: ServerEnv,
  user: SessionUser,
  runId: string,
): Promise<ApiResult> {
  const runs = analysisStorage(env).runs;
  const scope = accessScope(user);
  if (await runs.requestCancellation({ scope, runId, reason: "user_request" }))
    return { status: 202, body: { runId, status: "cancellation_requested" } };
  return (await runs.getRunProgress({ scope, runId }))
    ? { status: 409, body: { error: "The run has already finished." } }
    : { status: 404, body: { error: "Run not found." } };
}

export function isTerminalRunStatus(status: string) {
  return TERMINAL.has(status);
}

function analysisInput(body: FirstPartyAnalysisInput) {
  if ("text" in body) return { kind: "text" as const, text: body.text };
  if ("url" in body) return { kind: "link" as const, url: body.url };
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(body.image);
  return {
    kind: "image" as const,
    mimeType:
      body.imageMimeType?.toLowerCase() ?? match?.[1]?.toLowerCase() ?? "application/octet-stream",
    data: match
      ? body.image
      : `data:${body.imageMimeType ?? "application/octet-stream"};base64,${body.image}`,
    caption: null,
  };
}
