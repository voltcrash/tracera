import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { hashValue } from "@repo/ai/core/hashing";
import { createCoreJobPayload } from "@repo/ai/core/job";
import { CORE_V2_ENGINE_VERSION } from "@repo/ai/core/types";
import {
  CORE_V2_EVALUATION_BUDGET,
  runContextSchema,
  stageNameSchema,
  type RunContext,
} from "@repo/contracts/core-v2";
import { finishAnalysisAdmission, pool, type AnalysisAdmission } from "@repo/db";
import {
  CoreStorageRepository,
  type CoreAccessScope,
  type CoreRunProgress,
} from "@repo/db/core/repository";
import { authenticatedUser } from "./auth";
import {
  admitAnalysis,
  analysisAdmissionError,
  analysisControlConfig,
  analysisControlHeaders,
  analysisControlPayload,
  analysisControlStatus,
  analysisRateHeaders,
  readIdempotencyKey,
} from "./analysis-controls";
import { parseFirstPartyAnalysisInput, type FirstPartyAnalysisInput } from "./analysis-input";
import { TRACERA_API_BASE_PATH } from "./base-path";
import type { Bindings } from "./index";
import { readAnalysisRequestBody } from "./request-body";

type CoreContext = Context<{ Bindings: Bindings }>;

const TERMINAL_RUN_STATUSES = new Set<CoreRunProgress["status"]>([
  "complete",
  "partial",
  "unavailable",
  "failed",
  "canceled",
]);
const repository = () => new CoreStorageRepository(pool);

export const coreV2App = new Hono<{ Bindings: Bindings }>();

// No production worker host or shadow-mode approval exists yet, so durable v2 runs are only
// accepted where the deterministic local/test profile is sealed; deployed traffic stays on v1.
coreV2App.use("*", async (context, next) => {
  const environment = runtimeEnvironment(context.env);
  const enabled =
    (environment.TRACERA_PROFILE === "local" || environment.TRACERA_PROFILE === "test") &&
    environment.TRACERA_ANALYSIS_MODE === "fixture";
  if (!enabled) return context.json({ error: "Core v2 analysis is not enabled." }, 404);
  await next();
});

coreV2App.post("/analyze", async (context) => {
  const requestBody = await readAnalysisRequestBody(context.req.raw);
  if (requestBody.tooLarge) {
    return context.json({ error: "Request body is too large." }, 413);
  }
  const user = await authenticatedUser(context.req.raw, runtimeEnvironment(context.env));
  if (!user)
    return context.json({ error: "Sign in or create an account to start a fact-check." }, 401);
  const idempotency = readIdempotencyKey(context.req.raw);
  if (!idempotency.valid) return context.json({ error: idempotency.message }, 400);
  const parsed = parseFirstPartyAnalysisInput(requestBody.body);
  if (!parsed.success) return context.json({ error: parsed.error }, 400);
  const config = analysisControlConfig(context.env);
  const endpoint = "/v2/analyze";
  let admission: AnalysisAdmission;
  try {
    admission = await admitAnalysis({
      userId: user.id,
      request: context.req.raw,
      endpoint,
      body: parsed.data,
      idempotencyKey: idempotency.value,
      forceReanalysis: parsed.data.forceReanalysis === true,
      config,
      secret: context.env.BETTER_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET,
    });
  } catch {
    return context.json({ error: "Analysis controls are unavailable." }, 503);
  }
  if (admission.kind === "rejected") {
    const error = analysisAdmissionError(admission);
    return context.json(
      analysisControlPayload(error),
      analysisControlStatus(error.code),
      analysisControlHeaders(error),
    );
  }
  if (admission.kind === "replay") {
    return context.json(
      admission.responseBody as Record<string, unknown>,
      admission.responseStatus as 202 | 503,
      { "x-idempotency-replayed": "true" },
    );
  }

  const input = coreInput(parsed.data);
  const runContext = coreRunContext(user.id, input);
  const finish = (responseBody: Record<string, unknown>, responseStatus: 202 | 503) =>
    finishAnalysisAdmission({
      userId: user.id,
      endpoint,
      idempotencyKey: idempotency.value,
      leaseId: admission.leaseId,
      responseBody,
      responseStatus,
      idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    });
  try {
    await repository().enqueue({
      context: runContext,
      stage: "normalize_input",
      payload: createCoreJobPayload(input, { allowReuse: parsed.data.forceReanalysis !== true }),
      maxAttempts: 3,
    });
  } catch {
    const failure = { error: "The durable analysis could not be queued." };
    await finish(failure, 503);
    return context.json(failure, 503);
  }
  const runPath = `${TRACERA_API_BASE_PATH}/v2/runs/${runContext.runId}`;
  const response = {
    schemaVersion: 2 as const,
    engineVersion: CORE_V2_ENGINE_VERSION,
    runId: runContext.runId,
    status: "queued" as const,
    progressUrl: runPath,
    eventsUrl: `${runPath}/events`,
    cancelUrl: `${runPath}/cancel`,
    reportUrl: `/run/${runContext.runId}`,
  };
  await finish(response, 202);
  return context.json(response, 202, analysisRateHeaders(admission));
});

coreV2App.get("/runs/:id", async (context) => {
  const access = await accessFor(context);
  if (!access) return context.json({ error: "Not authenticated." }, 401);
  const state = await runState(access, context.req.param("id"));
  return state
    ? context.json({ schemaVersion: 2, ...state })
    : context.json({ error: "Run not found." }, 404);
});

/**
 * Progress stream. Closing it only stops this observer: the durable job keeps running, and a
 * reconnecting client resumes from the current persisted state.
 */
coreV2App.get("/runs/:id/events", async (context) => {
  const access = await accessFor(context);
  if (!access) return context.json({ error: "Not authenticated." }, 401);
  const runId = context.req.param("id");
  const initial = await runState(access, runId);
  if (!initial) return context.json({ error: "Run not found." }, 404);
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let lastEventId = context.req.header("last-event-id") ?? null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("retry: 2000\n\n"));
      const emit = (state: NonNullable<Awaited<ReturnType<typeof runState>>>) => {
        const eventId = `${state.progress.updatedAt}:${state.progress.completedStages.length}`;
        if (eventId !== lastEventId) {
          lastEventId = eventId;
          controller.enqueue(
            encoder.encode(
              `id: ${eventId}\nevent: progress\ndata: ${JSON.stringify({ schemaVersion: 2, ...state })}\n\n`,
            ),
          );
        }
        if (TERMINAL_RUN_STATUSES.has(state.progress.status)) {
          closed = true;
          controller.close();
        }
      };
      const poll = async () => {
        if (closed) return;
        try {
          const state = await runState(access, runId);
          if (closed) return;
          if (!state) {
            closed = true;
            controller.close();
            return;
          }
          emit(state);
        } catch {
          closed = true;
          controller.error(new Error("Progress is temporarily unavailable."));
          return;
        }
        if (!closed) timer = setTimeout(() => void poll(), 1_000);
      };
      emit(initial);
      if (!closed) timer = setTimeout(() => void poll(), 1_000);
    },
    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
});

coreV2App.post("/runs/:id/cancel", async (context) => {
  const access = await accessFor(context);
  if (!access) return context.json({ error: "Not authenticated." }, 401);
  const runId = context.req.param("id");
  const requested = await repository().requestCancellation({
    scope: access,
    runId,
    reason: "user_request",
  });
  if (requested) return context.json({ runId, status: "cancellation_requested" }, 202);
  return (await repository().getRunProgress({ scope: access, runId }))
    ? context.json({ error: "The run has already finished." }, 409)
    : context.json({ error: "Run not found." }, 404);
});

coreV2App.get("/runs/:id/evidence/:snapshotId", async (context) => {
  const access = await accessFor(context);
  if (!access) return context.json({ error: "Not authenticated." }, 401);
  const snapshotId = context.req.param("snapshotId");
  const report = await repository().getLatestReport({
    scope: access,
    runId: context.req.param("id"),
  });
  if (!report || !report.snapshots.some(({ id }) => id === snapshotId))
    return context.json({ error: "Evidence not found." }, 404);
  const snapshot = await repository().getSnapshot({ scope: access, snapshotId });
  if (!snapshot) return context.json({ error: "Evidence not found." }, 404);
  const start = context.req.query("start");
  const end = context.req.query("end");
  let excerpt: { start: number; end: number; quote: string } | null = null;
  if (start !== undefined || end !== undefined) {
    const span = { start: Number(start), end: Number(end) };
    if (
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > snapshot.normalizedText.length
    )
      return context.json({ error: "Excerpt offsets are invalid for this snapshot." }, 400);
    excerpt = { ...span, quote: snapshot.normalizedText.slice(span.start, span.end) };
  }
  return context.json({ schemaVersion: 2, snapshot, excerpt });
});

async function runState(scope: CoreAccessScope, runId: string) {
  const progress = await repository().getRunProgress({ scope, runId });
  if (!progress) return null;
  const report =
    TERMINAL_RUN_STATUSES.has(progress.status) && progress.status !== "canceled"
      ? await repository().getLatestReport({ scope, runId })
      : null;
  const completed = new Set(progress.completedStages);
  const currentStage = TERMINAL_RUN_STATUSES.has(progress.status)
    ? null
    : (stageNameSchema.options.find((stage) => !completed.has(stage)) ?? null);
  return { progress: { ...progress, currentStage }, report };
}

function coreRunContext(ownerUserId: string, input: ReturnType<typeof coreInput>): RunContext {
  return runContextSchema.parse({
    runId: randomUUID(),
    tenantId: `user:${ownerUserId}`,
    ownerUserId,
    visibility: "private",
    inputHash: hashValue(input),
    asOfTime: new Date().toISOString(),
    versions: {
      engine: CORE_V2_ENGINE_VERSION,
      prompt: "core-v2-prompts-1.0.0",
      model: "deterministic-fixture-v1",
      retriever: "core-v2-retrieval-1.0.0",
      embedding: {
        model: "deterministic-fixture-1024-v1",
        dimensions: 1024,
        preprocessing: "core-v2-normalized-text-1.0.0",
      },
      calibration: null,
    },
    executionMode: "fixture",
    budget: CORE_V2_EVALUATION_BUDGET,
    cancellation: { requested: false, requestedAt: null, reason: null },
    auditSinkId: `core-audit:${ownerUserId}`,
  });
}

function coreInput(body: FirstPartyAnalysisInput) {
  if ("text" in body) return { kind: "text" as const, text: body.text };
  if ("url" in body) return { kind: "link" as const, url: body.url };
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(body.image);
  return {
    kind: "image" as const,
    mimeType: body.imageMimeType ?? match?.[1] ?? "application/octet-stream",
    data: match?.[2] ?? body.image,
    caption: null,
  };
}

async function accessFor(context: CoreContext): Promise<CoreAccessScope | null> {
  const user = await authenticatedUser(context.req.raw, runtimeEnvironment(context.env));
  return user ? { tenantId: `user:${user.id}`, ownerUserId: user.id, visibility: "private" } : null;
}

function runtimeEnvironment(environment: Bindings) {
  return (environment.TRACERA_PROFILE ? environment : process.env) as Bindings;
}
