import { useEffect, useState } from "react";
import { useHydrated } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AnalysisReport } from "@/components/analysis/analysis-report";
import { apiUrl } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { RunViewState } from "@/server/run-view.server";
import { cancelRun } from "@/server/analysis.functions";

type Progress = RunViewState["progress"];

const TERMINAL = new Set<Progress["status"]>([
  "complete",
  "partial",
  "unavailable",
  "failed",
  "canceled",
]);

// Leaving the page only closes the progress stream; the run continues until it finishes or is
// explicitly canceled.
export function RunDetail({ id, initial }: { id: string; initial: RunViewState }) {
  const hydrated = useHydrated();
  const [state, setState] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const requestCancel = useServerFn(cancelRun);
  const terminal = TERMINAL.has(state.progress.status);
  const view = state.report;

  useEffect(() => {
    if (terminal) return;
    const source = new EventSource(`${apiUrl}/runs/${encodeURIComponent(id)}/events?view=report`);
    source.addEventListener("progress", (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as RunViewState;
      setError(null);
      setState({ progress: next.progress, report: next.report });
      if (TERMINAL.has(next.progress.status)) source.close();
    });
    source.onerror = () => setError("Live progress was interrupted. Reconnecting…");
    return () => source.close();
  }, [id, terminal]);

  async function cancel() {
    const result = await requestCancel({ data: { runId: id } });
    if (result.status !== 202) {
      setError(result.body.error ?? "Unable to cancel this run.");
      return;
    }
    setState((current) => ({
      ...current,
      progress: { ...current.progress, cancellationRequested: true },
    }));
  }

  if (view?.schemaVersion === 2)
    return (
      <main className="trace-page min-h-screen bg-background text-foreground">
        <AnalysisReport view={view} />
      </main>
    );
  const { progress } = state;
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
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="rounded-3xl bg-panel p-7 text-panel-foreground">
          <p className="text-sm text-white/60">
            {terminal ? "Analysis ended" : "Analysis in progress"}
          </p>
          <h1 className="mt-2 text-2xl font-bold">{headline(progress)}</h1>
          <p className="mt-3 text-sm text-white/60">
            Attempt {progress.attempt} · {progress.completedStages.length} of 8 stages recorded
          </p>
          {!progress.cancellationRequested && !terminal ? (
            <Button
              className="mt-6"
              variant="outline"
              disabled={!hydrated}
              onClick={() => void cancel()}
            >
              Cancel analysis
            </Button>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function headline(progress: Progress) {
  if (progress.status === "canceled") return "Analysis canceled";
  if (progress.status === "failed") return "Analysis could not finish";
  if (progress.status === "partial") return "Analysis completed with limitations";
  if (progress.status === "unavailable") return "Analysis unavailable";
  if (progress.cancellationRequested) return "Cancellation requested";
  return progress.currentStage ? `Stage: ${progress.currentStage.replaceAll("_", " ")}` : "Queued";
}
