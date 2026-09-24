import { Hono, type Context } from "hono";
import { runReportSchema, stageNameSchema } from "@repo/contracts/core-v2";
import { finishAnalysisAdmission, pool, type AnalysisAdmission, type AuthUser } from "@repo/db";
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
import {
  executeFocusedRun,
  focusedRunContext,
  focusedRuntimePolicy,
  type CoreRuntimeRepository,
  type FocusedRuntimePolicyResult,
} from "./analysis-runtime";

type CoreContext = Context<{ Bindings: Bindings }>;

const TERMINAL_RUN_STATUSES = new Set<CoreRunProgress["status"]>([
  "complete",
  "partial",
  "unavailable",
  "failed",
  "canceled",
]);

type Authenticate = (request: Request, environment: Bindings) => Promise<AuthUser | null>;
type Admit = typeof admitAnalysis;
type Finish = typeof finishAnalysisAdmission;
type Execute = typeof executeFocusedRun;

export interface AnalysisDependencies {
  repository?: CoreRuntimeRepository;
  authenticate?: Authenticate;
  admit?: Admit;
  finish?: Finish;
  execute?: Execute;
  policy?: (environment: Record<string, string | undefined>) => FocusedRuntimePolicyResult;
}

export function createAnalysisApp(dependencies: AnalysisDependencies = {}) {
  const app = new Hono<{ Bindings: Bindings }>();
  const configuredRepository = dependencies.repository;
  const storage = () => configuredRepository ?? new CoreStorageRepository(pool);
  const authenticate = dependencies.authenticate ?? authenticatedUser;
  const admit = dependencies.admit ?? admitAnalysis;
  const finish = dependencies.finish ?? finishAnalysisAdmission;
  const execute = dependencies.execute ?? executeFocusedRun;
  const policy = dependencies.policy ?? focusedRuntimePolicy;

  app.post("/analyze", async (context) => {
    const requestBody = await readAnalysisRequestBody(context.req.raw);
    if (requestBody.tooLarge) {
      return context.json({ error: "Request body is too large." }, 413);
    }
    const environment = runtimeEnvironment(context.env);
    const user = await authenticate(context.req.raw, environment);
    if (!user)
      return context.json({ error: "Sign in or create an account to start a fact-check." }, 401);
    const parsed = parseFirstPartyAnalysisInput(requestBody.body);
    if (!parsed.success) return context.json({ error: parsed.error }, 400);
    const runtime = policy(environment);
    if (!runtime.enabled) return focusedUnavailableResponse(context, runtime);
    const idempotency = readIdempotencyKey(context.req.raw);
    if (!idempotency.valid) return context.json({ error: idempotency.message }, 400);
    const config = analysisControlConfig(context.env);
    const endpoint = "/analyze";
    let admission: AnalysisAdmission;
    try {
      admission = await admit({
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
        admission.responseStatus as 200 | 409 | 503,
        { "x-idempotency-replayed": "true" },
      );
    }

    const input = coreInput(parsed.data);
    const runContext = focusedRunContext(user.id, input, runtime.policy);
    const finishAdmission = (responseBody: Record<string, unknown>, responseStatus: number) =>
      finish({
        userId: user.id,
        endpoint,
        idempotencyKey: idempotency.value,
        leaseId: admission.leaseId,
        responseBody,
        responseStatus,
        idempotencyTtlSeconds: config.idempotencyTtlSeconds,
      });
    try {
      const result = await execute({
        repository: storage(),
        context: runContext,
        analysis: { input, seed: 20260910 },
        policy: runtime.policy,
        controls: config,
        environment,
        signal: context.req.raw.signal,
      });

      if (!result.report) {
        const response = {
          schemaVersion: 2 as const,
          runId: runContext.runId,
          status: result.status,
          error:
            result.status === "canceled"
              ? "The analysis was canceled before a report was saved."
              : "The analysis did not produce a saved report.",
        } satisfies Record<string, unknown>;
        const responseStatus = result.status === "canceled" ? 409 : 503;
        await finishAdmission(response, responseStatus);
        return context.json(response, responseStatus, analysisRateHeaders(admission));
      }

      const report = runReportSchema.parse(result.report);
      const runPath = `${TRACERA_API_BASE_PATH}/runs/${runContext.runId}`;
      const response = {
        schemaVersion: 2 as const,
        engineVersion: runContext.versions.engine,
        runId: runContext.runId,
        status: report.status,
        report,
        progressUrl: runPath,
        eventsUrl: `${runPath}/events`,
        cancelUrl: `${runPath}/cancel`,
        reportUrl: `/run/${runContext.runId}`,
      };
      await finishAdmission(response, 200);
      return context.json(response, 200, analysisRateHeaders(admission));
    } catch (error) {
      console.error("Analysis request failed", error);
      const failure = {
        schemaVersion: 2 as const,
        runId: runContext.runId,
        status: "failed" as const,
        code: "core_v2_failed" as const,
        error: "The focused analysis failed before a report could be returned.",
      };
      await finishAdmission(failure, 503).catch(() => undefined);
      return context.json(failure, 503, analysisRateHeaders(admission));
    }
  });

  app.get("/runs", async (context) => {
    const access = await accessFor(context, authenticate);
    if (!access) return context.json({ error: "Not authenticated." }, 401);
    const runs = await storage().listRuns({ scope: access, limit: 30 });
    return context.json({
      schemaVersion: 2,
      runs: runs.map(({ runId, status, createdAt, report }) => ({
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
      })),
    });
  });

  app.get("/runs/:id", async (context) => {
    const access = await accessFor(context, authenticate);
    if (!access) return context.json({ error: "Not authenticated." }, 401);
    const state = await runState(storage(), access, context.req.param("id"));
    return state
      ? context.json({ schemaVersion: 2, ...state })
      : context.json({ error: "Run not found." }, 404);
  });

  /** Closing this observer does not change the persisted run state. */
  app.get("/runs/:id/events", async (context) => {
    const access = await accessFor(context, authenticate);
    if (!access) return context.json({ error: "Not authenticated." }, 401);
    const runId = context.req.param("id");
    const initial = await runState(storage(), access, runId);
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
            const state = await runState(storage(), access, runId);
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

  app.post("/runs/:id/cancel", async (context) => {
    const access = await accessFor(context, authenticate);
    if (!access) return context.json({ error: "Not authenticated." }, 401);
    const runId = context.req.param("id");
    const requested = await storage().requestCancellation({
      scope: access,
      runId,
      reason: "user_request",
    });
    if (requested) return context.json({ runId, status: "cancellation_requested" }, 202);
    return (await storage().getRunProgress({ scope: access, runId }))
      ? context.json({ error: "The run has already finished." }, 409)
      : context.json({ error: "Run not found." }, 404);
  });

  app.get("/runs/:id/evidence/:snapshotId", async (context) => {
    const access = await accessFor(context, authenticate);
    if (!access) return context.json({ error: "Not authenticated." }, 401);
    const snapshotId = context.req.param("snapshotId");
    const report = await storage().getLatestReport({
      scope: access,
      runId: context.req.param("id"),
    });
    if (!report || !report.snapshots.some(({ id }) => id === snapshotId))
      return context.json({ error: "Evidence not found." }, 404);
    const snapshot = await storage().getSnapshot({ scope: access, snapshotId });
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

  return app;
}

export const analysisApp = createAnalysisApp();

async function runState(repository: CoreRuntimeRepository, scope: CoreAccessScope, runId: string) {
  const progress = await repository.getRunProgress({ scope, runId });
  if (!progress) return null;
  const report =
    TERMINAL_RUN_STATUSES.has(progress.status) && progress.status !== "canceled"
      ? await repository.getLatestReport({ scope, runId })
      : null;
  const completed = new Set(progress.completedStages);
  const currentStage = TERMINAL_RUN_STATUSES.has(progress.status)
    ? null
    : (stageNameSchema.options.find((stage) => !completed.has(stage)) ?? null);
  return { progress: { ...progress, currentStage }, report };
}

function coreInput(body: FirstPartyAnalysisInput) {
  if ("text" in body) return { kind: "text" as const, text: body.text };
  if ("url" in body) return { kind: "link" as const, url: body.url };
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(body.image);
  return {
    kind: "image" as const,
    mimeType:
      body.imageMimeType?.toLowerCase() ?? match?.[1]?.toLowerCase() ?? "application/octet-stream",
    data: match?.[2] ?? body.image,
    caption: null,
  };
}

async function accessFor(
  context: CoreContext,
  authenticate: Authenticate,
): Promise<CoreAccessScope | null> {
  const user = await authenticate(context.req.raw, runtimeEnvironment(context.env));
  return user ? { tenantId: `user:${user.id}`, ownerUserId: user.id, visibility: "private" } : null;
}

function focusedUnavailableResponse(
  context: CoreContext,
  runtime: Extract<FocusedRuntimePolicyResult, { enabled: false }>,
) {
  return context.json(
    {
      schemaVersion: 2 as const,
      status: "unavailable" as const,
      code: runtime.code,
      error: runtime.message,
    },
    503,
  );
}

function runtimeEnvironment(environment: Bindings) {
  return (environment.TRACERA_PROFILE ? environment : process.env) as Bindings;
}
