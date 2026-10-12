import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { projectReport } from "@repo/ai/analysis/report-view";
import { AnalysisReport } from "@/components/analysis/analysis-report";
import { apiUrl } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { RunState } from "@/server/analysis-api.server";
import { cancelRun } from "@/server/analysis.functions";

type Progress = RunState["progress"];

const TERMINAL = new Set<Progress["status"]>([
  "complete",
  "partial",
  "unavailable",
  "failed",
  "canceled",
]);

// Leaving the page only closes the progress stream; the run continues until it finishes or is
// explicitly canceled.
export function RunDetail({ id, initial }: { id: string; initial: RunState }) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const requestCancel = useServerFn(cancelRun);
  const terminal = TERMINAL.has(state.progress.status);
  const view = useMemo(
    () => (state.report ? projectReport(state.report, apiUrl) : null),
    [state.report],
  );

  useEffect(() => {
    if (terminal) return;
    const source = new EventSource(`${apiUrl}/runs/${encodeURIComponent(id)}/events`);
    source.addEventListener("progress", (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as RunState;
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
            <Button className="mt-6" variant="outline" onClick={() => void cancel()}>
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
