"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { projectReport, type ReportView } from "@repo/ai/core/report-view";
import { CoreV2Report } from "@/components/analysis/core-v2-report";
import { useAuth } from "@/components/providers/auth-provider";
import { apiUrl } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type Progress = {
  status: "queued" | "leased" | "retry" | "complete" | "failed" | "canceled";
  currentStage: string | null;
  attempt: number;
  completedStages: string[];
  cancellationRequested: boolean;
};

const TERMINAL = new Set<Progress["status"]>(["complete", "failed", "canceled"]);

export function CoreRunDetail({ id }: { id: string }) {
  const { apiFetch, user, isLoading } = useAuth();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [view, setView] = useState<ReportView | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Leaving the page only stops polling; the durable run continues until it finishes or is
  // explicitly canceled.
  useEffect(() => {
    if (!user || isLoading) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await apiFetch(`${apiUrl}/v2/runs/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        const data = (await response.json()) as {
          progress?: Progress;
          report?: unknown;
          error?: string;
        };
        if (!response.ok || !data.progress)
          throw new Error(data.error ?? "Unable to load this run.");
        setError(null);
        setProgress(data.progress);
        setView(data.report ? projectReport(data.report, apiUrl) : null);
        if (!TERMINAL.has(data.progress.status)) timer = setTimeout(() => void poll(), 1_000);
      } catch (requestError) {
        if (controller.signal.aborted) return;
        setError(requestError instanceof Error ? requestError.message : "Unable to load this run.");
        timer = setTimeout(() => void poll(), 3_000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [apiFetch, id, isLoading, user]);

  async function cancel() {
    const response = await apiFetch(`${apiUrl}/v2/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Unable to cancel this run.");
      return;
    }
    setProgress((current) => (current ? { ...current, cancellationRequested: true } : current));
  }

  if (view?.schemaVersion === 2)
    return (
      <main className="trace-page min-h-screen bg-background text-foreground">
        <CoreV2Report view={view} />
      </main>
    );
  return (
    <main className="trace-page min-h-screen bg-background text-foreground">
      <section className="trace mt-16">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {view?.schemaVersion === 1 ? (
          <Link className="underline" href={view.href}>
            Open the saved report
          </Link>
        ) : !progress ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : (
          <div className="rounded-3xl bg-panel p-7 text-panel-foreground">
            <p className="text-sm text-white/60">Core v2 durable run</p>
            <h1 className="mt-2 text-2xl font-bold">{headline(progress)}</h1>
            <p className="mt-3 text-sm text-white/60">
              Attempt {progress.attempt} · {progress.completedStages.length} of 8 stages
              checkpointed
            </p>
            {!progress.cancellationRequested && !TERMINAL.has(progress.status) ? (
              <Button className="mt-6" variant="outline" onClick={() => void cancel()}>
                Cancel analysis
              </Button>
            ) : null}
          </div>
        )}
      </section>
    </main>
  );
}

function headline(progress: Progress) {
  if (progress.status === "canceled") return "Analysis canceled";
  if (progress.status === "failed") return "Analysis could not finish";
  if (progress.cancellationRequested) return "Cancellation requested";
  if (progress.status === "retry") return "Retrying after an interruption";
  return progress.currentStage ? `Stage: ${progress.currentStage.replaceAll("_", " ")}` : "Queued";
}
