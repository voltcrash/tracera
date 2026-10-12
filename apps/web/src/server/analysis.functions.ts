import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeaders } from "@tanstack/react-start/server";
import {
  cancelAnalysisRun,
  listAnalysisRuns,
  readRunState,
  startAnalysisRun,
} from "./analysis-api.server";
import { authMiddleware } from "./auth-middleware";
import { serverEnv } from "./env";

/** The Hono route's 7.1 MB body limit, now applied to the server function input. */
export const MAX_ANALYSIS_INPUT_BYTES = 7_100_000;

export type StartAnalysisInput = { idempotencyKey: string; input: Record<string, unknown> };
/** Every field the start, replay, control-error and cancel responses can carry. */
export type ApiBody = {
  schemaVersion?: number;
  engineVersion?: string;
  runId?: string;
  status?: string;
  code?: string;
  error?: string;
  retryAfterSeconds?: number;
  eventsUrl?: string;
  reportUrl?: string;
};
export type ApiOutcome = { status: number; body: ApiBody };

export function validateStartAnalysisInput(data: unknown): StartAnalysisInput {
  if (new TextEncoder().encode(JSON.stringify(data ?? null)).byteLength > MAX_ANALYSIS_INPUT_BYTES)
    throw new Error("Request body is too large.");
  const value = data as Partial<StartAnalysisInput> | null;
  if (
    !value ||
    typeof value.idempotencyKey !== "string" ||
    !value.input ||
    typeof value.input !== "object" ||
    Array.isArray(value.input)
  )
    throw new Error("Provide an idempotency key and an analysis input.");
  return { idempotencyKey: value.idempotencyKey, input: value.input };
}

function runIdInput(data: unknown) {
  const runId = (data as { runId?: unknown } | null)?.runId;
  if (typeof runId !== "string" || !runId) throw new Error("A run ID is required.");
  return { runId };
}

function outcome(result: {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}): ApiOutcome {
  if (result.headers) setResponseHeaders(new Headers(result.headers));
  return { status: result.status, body: result.body as ApiBody };
}

export const getMe = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(({ context }) => ({ user: context.user }));

export const startAnalysis = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(validateStartAnalysisInput)
  .handler(async ({ context, data }) =>
    outcome(
      await startAnalysisRun({
        env: serverEnv(),
        user: context.user,
        request: getRequest(),
        body: data.input,
        idempotencyKey: data.idempotencyKey,
      }),
    ),
  );

export const listRuns = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => ({ runs: await listAnalysisRuns(serverEnv(), context.user) }));

export const getRun = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(runIdInput)
  .handler(async ({ context, data }) => {
    const state = await readRunState(serverEnv(), context.user, data.runId);
    if (!state) throw notFound();
    return state;
  });

export const cancelRun = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(runIdInput)
  .handler(async ({ context, data }) =>
    outcome(await cancelAnalysisRun(serverEnv(), context.user, data.runId)),
  );
