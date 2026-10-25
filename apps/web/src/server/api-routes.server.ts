import {
  accessScope,
  analysisStorage,
  isTerminalRunStatus,
  readRunState,
  type RunState,
} from "./analysis-api.server";
import type { ServerEnv } from "./env";
import {
  logServerError,
  REQUEST_ID_HEADER,
  requestIdFor,
  SERVICE_UNAVAILABLE_MESSAGE,
} from "./error-handling";
import { projectRunState } from "./run-view.server";
import { readSessionUser } from "./session.server";

const POLL_MS = 1_000;

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(body, { status, headers });
}

/** Streams run progress as server-sent events until the run is terminal. Closing the stream does not change the run. */
export async function runEventsResponse(env: ServerEnv, request: Request, runId: string) {
  const user = await readSessionUser(env, request);
  if (!user) return json({ error: "Not authenticated." }, 401);
  const initial = await readRunState(env, user, runId);
  if (!initial) return json({ error: "Run not found." }, 404);
  const displayView = new URL(request.url).searchParams.get("view") === "report";
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let lastEventId = request.headers.get("last-event-id");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("retry: 2000\n\n"));
      const emit = (state: RunState) => {
        const eventId = `${state.progress.updatedAt}:${state.progress.completedStages.length}`;
        if (eventId !== lastEventId) {
          lastEventId = eventId;
          controller.enqueue(
            encoder.encode(
              `id: ${eventId}\nevent: progress\ndata: ${JSON.stringify({ schemaVersion: 2, ...(displayView ? projectRunState(state) : state) })}\n\n`,
            ),
          );
        }
        if (isTerminalRunStatus(state.progress.status)) {
          closed = true;
          controller.close();
        }
      };
      const poll = async () => {
        if (closed) return;
        try {
          const state = await readRunState(env, user, runId);
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
        if (!closed) timer = setTimeout(() => void poll(), POLL_MS);
      };
      emit(initial);
      if (!closed) timer = setTimeout(() => void poll(), POLL_MS);
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
}

export async function evidenceResponse(
  env: ServerEnv,
  request: Request,
  runId: string,
  snapshotId: string,
) {
  const user = await readSessionUser(env, request);
  if (!user) return json({ error: "Not authenticated." }, 401);
  const runs = analysisStorage(env).runs;
  const scope = accessScope(user);
  const report = await runs.getLatestReport({ scope, runId });
  const snapshot = report?.snapshots.find(({ id }) => id === snapshotId);
  if (!snapshot) return json({ error: "Evidence not found." }, 404);
  const search = new URL(request.url).searchParams;
  const start = search.get("start");
  const end = search.get("end");
  let excerpt: { start: number; end: number; quote: string } | null = null;
  if (start !== null || end !== null) {
    const span = { start: Number(start), end: Number(end) };
    if (
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > snapshot.normalizedText.length
    )
      return json({ error: "Excerpt offsets are invalid for this snapshot." }, 400);
    excerpt = { ...span, quote: snapshot.normalizedText.slice(span.start, span.end) };
  }
  return json({ schemaVersion: 2, snapshot, excerpt });
}

export async function healthResponse(env: ServerEnv, request: Request) {
  try {
    const row = await env.DB.prepare("SELECT 1 AS connected").first<{ connected: number }>();
    const database = row?.connected === 1 ? "connected" : "unavailable";
    return json({ status: "ok", services: { database } });
  } catch (error) {
    const requestId = requestIdFor(request);
    logServerError("Health check failed", error, request);
    return json({ status: "error", message: SERVICE_UNAVAILABLE_MESSAGE, requestId }, 503, {
      [REQUEST_ID_HEADER]: requestId,
    });
  }
}
