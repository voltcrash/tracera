import { useCallback, useEffect, useRef, useState } from "react";
import { isTerminalRunStatus } from "@repo/contracts/run-lifecycle";
import { useHydrated } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AnalysisReport } from "@/components/analysis/analysis-report";
import { apiUrl } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { RunViewState } from "@/server/run-view.server";
import { cancelRun } from "@/server/analysis.functions";
import {
  decodeProgress,
  progressHeadline,
  transitionProgress,
  type RunProgressState,
  type ProgressEvent,
} from "@/lib/run-progress";

// Leaving the page only closes the progress stream; the run continues until it finishes or is
// explicitly canceled.
export function RunDetail({ id, initial }: { id: string; initial: RunViewState }) {
  const hydrated = useHydrated();
  const [state, setState] = useState<RunProgressState>({
    view: initial,
    connection: "connecting",
    cancellation: { status: "idle" },
  });
  const current = useRef(state);
  const mounted = useRef(true);
  const send = useCallback((event: ProgressEvent) => {
    const next = transitionProgress(current.current, event);
    current.current = next;
    setState(next);
    return next;
  }, []);
  const requestCancel = useServerFn(cancelRun);
  const terminal = isTerminalRunStatus(state.view.progress.status);
  const view = state.view.report;
  const connectionError =
    state.connection === "access_lost"
      ? "Access to this trace ended. Sign in again or reload the page."
      : state.connection === "closed"
        ? "Live progress stopped. Reload the page to reconnect."
        : state.connection === "reconnecting"
          ? "Live progress was interrupted. Reconnecting…"
          : null;
  const cancellationError =
    state.cancellation.status === "failed" ? state.cancellation.error : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (terminal) return;
    const source = new EventSource(`${apiUrl}/runs/${encodeURIComponent(id)}/events?view=report`);
    let active = true;
    source.addEventListener("open", () => {
      if (active) send({ type: "connection", status: "live" });
    });
    source.addEventListener("progress", (event) => {
      if (!active) return;
      const next = decodeProgress((event as MessageEvent<string>).data, id);
      if (!next) return;
      const accepted = send({ type: "progress", view: next });
      if (isTerminalRunStatus(accepted.view.progress.status)) source.close();
    });
    source.addEventListener("access_lost", () => {
      if (!active) return;
      send({ type: "connection", status: "access_lost" });
      source.close();
    });
    source.onerror = () => {
      if (active)
        send({
          type: "connection",
          status: source.readyState === EventSource.CLOSED ? "closed" : "reconnecting",
        });
    };
    return () => {
      active = false;
      source.close();
    };
  }, [id, terminal, send]);

  async function cancel() {
    const before = current.current;
    if (
      before.connection === "access_lost" ||
      isTerminalRunStatus(before.view.progress.status) ||
      before.view.progress.cancellationRequested ||
      before.cancellation.status === "pending" ||
      before.cancellation.status === "requested"
    )
      return;
    send({ type: "cancel_start" });
    try {
      const result = await requestCancel({ data: { runId: id } });
      if (!mounted.current) return;
      if (result.status === 202) send({ type: "cancel_accepted" });
      else
        send({ type: "cancel_failed", error: result.body.error ?? "Unable to cancel this run." });
    } catch {
      if (mounted.current)
        send({ type: "cancel_failed", error: "Unable to confirm cancellation. Try again." });
    }
  }

  if (view?.schemaVersion === 2)
    return (
      <main className="trace-page min-h-screen bg-background text-foreground">
        <AnalysisReport view={view} />
      </main>
    );
  const { progress } = state.view;
  return (
    <main className="trace-page min-h-screen bg-background text-foreground">
      <section className="trace mt-16">
        {progress.errorCode === "provider_key_rejected" ? (
          <Alert variant="destructive">
            <AlertDescription>
              Your key was rejected. Update your provider key in Settings and try again.
            </AlertDescription>
          </Alert>
        ) : null}
        {progress.errorCode === "provider_revision_unavailable" ? (
          <Alert variant="destructive">
            <AlertDescription>
              The provider key for this trace is no longer available. Choose a key in Settings and
              start a new trace.
            </AlertDescription>
          </Alert>
        ) : null}
        {connectionError || cancellationError ? (
          <Alert variant="destructive">
            <AlertDescription>{cancellationError ?? connectionError}</AlertDescription>
          </Alert>
        ) : null}
        <div className="rounded-3xl bg-panel p-7 text-panel-foreground">
          <p className="text-sm text-white/60">
            {terminal ? "Analysis ended" : "Analysis in progress"}
          </p>
          <h1 className="mt-2 text-2xl font-bold">
            {progressHeadline(progress, state.cancellation.status === "requested")}
          </h1>
          <p className="mt-3 text-sm text-white/60">
            Attempt {progress.attempt} · {progress.recordedStages.length} of 8 stages recorded
          </p>
          {!progress.cancellationRequested &&
          state.cancellation.status !== "requested" &&
          state.connection !== "access_lost" &&
          !terminal ? (
            <Button
              className="mt-6"
              variant="outline"
              disabled={!hydrated || state.cancellation.status === "pending"}
              aria-busy={state.cancellation.status === "pending" || undefined}
              onClick={() => void cancel()}
            >
              {state.cancellation.status === "pending"
                ? "Requesting cancellation…"
                : "Cancel analysis"}
            </Button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
