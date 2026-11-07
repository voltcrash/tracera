import { isTerminalRunStatus } from "@repo/contracts/run-lifecycle";
export { isTerminalRunStatus } from "@repo/contracts/run-lifecycle";
import type { AnalysisAccessScope, AnalysisAdmission } from "@repo/db";
import {
  createD1AdmissionRepository,
  createD1AnalysisRepository,
  type D1RepositoryOptions,
} from "@repo/db";
import {
  admitAnalysis,
  analysisAdmissionError,
  analysisControlConfig,
  analysisControlHeaders,
  analysisControlPayload,
  analysisControlStatus,
  analysisRateHeaders,
  analysisRequestIdentity,
  validIdempotencyKey,
} from "./analysis-controls";
import { parseFirstPartyAnalysisInput, type FirstPartyAnalysisInput } from "./analysis-input";
import { analysisPolicy, analysisRunContext } from "./analysis-policy";
import { personalProviderSelection } from "./provider-selection.server";
import type { ServerEnv } from "./env";
import { logServerError } from "./error-handling";
import type { SessionUser } from "./session";
import { workflowAdmissionLeaseSeconds, type AnalysisWorkflowParams } from "./workflow-params";
import { launchAnalysisWorkflow } from "./analysis-launch.server";

export const START_ANALYSIS_ENDPOINT = "startAnalysis";
export const ANALYSIS_SEED = 20260910;

export type ApiResult = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

export function analysisStorage(env: ServerEnv, now?: () => number) {
  // Wrangler's generated runtime types and @cloudflare/workers-types describe the same bindings.
  const options = { database: env.DB, bucket: env.BLOBS, now } as unknown as D1RepositoryOptions;
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
  const idempotency = validIdempotencyKey(input.idempotencyKey);
  if (!idempotency.valid) return { status: 400, body: { error: idempotency.message } };
  const storage = analysisStorage(env);
  try {
    const existing = await storage.admission.readAnalysisAdmission({
      userId: user.id,
      endpoint: START_ANALYSIS_ENDPOINT,
      idempotencyKey: idempotency.value,
      requestHash: analysisRequestIdentity(request, parsed.data, env.BETTER_AUTH_SECRET)
        .requestHash,
    });
    if (existing) return admissionResponse(existing);
  } catch {
    return { status: 503, body: { error: "Analysis controls are unavailable." } };
  }
  let selection: Awaited<ReturnType<typeof personalProviderSelection>>;
  try {
    if (env.ANALYSIS_MODE === "live") selection = await personalProviderSelection(env, user.id);
  } catch {
    return {
      status: 503,
      body: {
        code: "analysis_unavailable",
        status: "unavailable",
        error: "Analysis is not available right now.",
      },
    };
  }
  const runtime = analysisPolicy(env, user.id, selection);
  if (!runtime.enabled)
    return {
      status: 503,
      // The policy message names settings, which is operator detail rather than user copy.
      body: {
        schemaVersion: 2,
        status: "unavailable",
        code: runtime.code,
        error: "Analysis is not available right now.",
      },
    };
  const config = analysisControlConfig(env);
  config.leaseSeconds = workflowAdmissionLeaseSeconds(
    config.leaseSeconds,
    runtime.policy.budget.maxElapsedMs,
  );
  let admission: Awaited<ReturnType<typeof admitAnalysis>>;
  try {
    admission = await admitAnalysis({
      userId: user.id,
      keySource: runtime.policy.providerIdentity?.source,
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
  if (admission.kind !== "admitted") return admissionResponse(admission);

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
      payload: {
        input: analysisInput(parsed.data),
        seed: ANALYSIS_SEED,
        admission: params.admission,
      },
      offloadInput: "image" in parsed.data,
      launchAdmission: params.admission,
    });
  } catch (error) {
    logServerError("Analysis persistence needs reconciliation", error, request);
    const persisted = await storage.runs
      .getRunContext({ scope: accessScope(user), runId: context.runId })
      .catch(() => undefined);
    if (!persisted) {
      const failure = {
        schemaVersion: 2,
        runId: context.runId,
        status: persisted === null ? "failed" : "unavailable",
        code: "analysis_start_failed",
        error:
          persisted === null
            ? "The analysis could not be started. Please try again."
            : "The analysis could not be confirmed. Please check your history.",
      };
      if (persisted === null) {
        await storage.admission
          .finishAnalysisAdmission({
            userId: user.id,
            ...params.admission,
            responseBody: failure,
            responseStatus: 503,
            idempotencyTtlSeconds: config.idempotencyTtlSeconds,
          })
          .catch(() => undefined);
      }
      return { status: 503, body: failure, headers: analysisRateHeaders(admission) };
    }
  }
  const launchStatus = await launchAnalysisWorkflow(env, params);
  await storage.runs
    .recordWorkflowLaunch({ scope: accessScope(user), runId: context.runId, status: launchStatus })
    .catch((error: unknown) =>
      logServerError("Analysis launch reconciliation is pending", error, request),
    );
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

function admissionResponse(admission: Exclude<AnalysisAdmission, { kind: "admitted" }>): ApiResult {
  if (admission.kind === "replay")
    return {
      status: admission.responseStatus,
      body: admission.responseBody as Record<string, unknown>,
      headers: { "x-idempotency-replayed": "true" },
    };
  const error = analysisAdmissionError(admission);
  return {
    status: analysisControlStatus(error.code),
    body: analysisControlPayload(error),
    headers: analysisControlHeaders(error),
  };
}

export async function listAnalysisRuns(env: ServerEnv, user: SessionUser) {
  return analysisStorage(env).runs.listRunSummaries({ scope: accessScope(user), limit: 30 });
}

export async function readRunState(env: ServerEnv, user: SessionUser, runId: string) {
  const runs = analysisStorage(env).runs;
  const scope = accessScope(user);
  const progress = await runs.getRunProgress({ scope, runId });
  if (!progress) return null;
  const terminal = isTerminalRunStatus(progress.status);
  const report =
    terminal && progress.status !== "canceled"
      ? await runs.getLatestReport({ scope, runId })
      : null;
  const currentStage = terminal ? null : progress.nextStage;
  return {
    progress: { ...progress, currentStage },
    report,
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
