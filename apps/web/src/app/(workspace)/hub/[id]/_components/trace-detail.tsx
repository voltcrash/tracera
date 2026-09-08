"use client";

import { useEffect, useState } from "react";
import type { ClaimResult, FramingAnalysis, TraceraScore } from "@repo/contracts";
import { TraceAside, TraceReport, type GroundZeroTrace } from "@/components/analysis/trace-report";
import { useAuth } from "@/components/providers/auth-provider";
import { apiUrl } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Check = {
  id: string;
  rawInput: string;
  createdAt: string;
  traceraScore: TraceraScore;
  analysis: { claims: ClaimResult[]; score: TraceraScore; framing?: FramingAnalysis };
  sourceDomain: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  groundZero?: GroundZeroTrace;
};
type TimelineEntry = {
  id: string;
  supersedes_check_id: string | null;
  tracera_score: TraceraScore;
  created_at: string;
  source_domain: string | null;
  lineage_reason: "first_check" | "related_story" | "scheduled_recheck";
};
type AppearanceEntry = {
  id: string;
  check_id: string;
  source_url: string | null;
  source_domain: string | null;
  occurrence_type: string;
  observed_at: string;
};

export function TraceDetail({ id }: { id: string }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [appearances, setAppearances] = useState<AppearanceEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { apiFetch, isLoading: isAuthLoading, user } = useAuth();

  useEffect(() => {
    if (isAuthLoading || !user || !id) return;
    void Promise.all([
      apiFetch(`${apiUrl}/checks/${id}`),
      apiFetch(`${apiUrl}/checks/${id}/timeline`),
      apiFetch(`${apiUrl}/checks/${id}/appearances`),
    ])
      .then(async ([checkResponse, timelineResponse, appearancesResponse]) => {
        const [checkData, timelineData, appearancesData] = await Promise.all([
          checkResponse.json(),
          timelineResponse.json(),
          appearancesResponse.json(),
        ]);
        if (!checkResponse.ok) {
          throw new Error(checkData.error ?? "Unable to load this check.");
        }
        setCheck(checkData.check);
        if (timelineResponse.ok && Array.isArray(timelineData.timeline)) {
          setTimeline(timelineData.timeline);
        }
        if (appearancesResponse.ok && Array.isArray(appearancesData.appearances)) {
          setAppearances(appearancesData.appearances);
        }
      })
      .catch((requestError) =>
        setError(
          requestError instanceof Error ? requestError.message : "Unable to load this check.",
        ),
      );
  }, [apiFetch, id, isAuthLoading, user]);

  return (
    <main className="trace-page min-h-screen bg-background text-foreground">
      {isAuthLoading && (
        <p className="trace mt-10 text-sm text-ink-soft" role="status">
          Restoring your account…
        </p>
      )}
      {!isAuthLoading && user && (
        <>
          {error && (
            <Alert variant="destructive" className="trace mt-10">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {!check && !error && (
            <div className="trace mt-16 space-y-4" role="status">
              <Skeleton className="h-24 w-2/3 rounded-xl" />
              <Skeleton className="h-40 rounded-xl" />
              <span className="sr-only">Reassembling the evidence trail…</span>
            </div>
          )}
          {check && (
            <TraceReport
              statement={check.rawInput}
              checkedAt={check.createdAt}
              sourceDomain={check.sourceDomain}
              sourceUrl={check.sourceUrl}
              claims={check.analysis.claims}
              score={check.analysis.score ?? check.traceraScore}
              framing={check.analysis.framing}
              groundZero={check.groundZero}
              backHref="/hub"
              backLabel="News Hub"
            >
              <TraceHistory entries={timeline} appearances={appearances} />
            </TraceReport>
          )}
        </>
      )}
    </main>
  );
}

function TraceHistory({
  entries,
  appearances,
}: {
  entries: TimelineEntry[];
  appearances: AppearanceEntry[];
}) {
  if (entries.length === 0 && appearances.length === 0) return null;
  const repeats = appearances.filter((item) => item.occurrence_type === "exact_resubmission");

  return (
    <TraceAside
      id="history"
      margin={`${entries.length} ${entries.length === 1 ? "version" : "versions"}`}
      gloss="Every time Tracera rescored this story."
    >
      <h2 className="trace-section-title">How this check has changed</h2>
      <p className="trace-section-say">
        Evidence keeps arriving after a story is published, so a score is only true for the day it
        was given.
      </p>

      <ol className="trace-history">
        {entries.map((entry, index) => {
          const previous = entries[index - 1];
          const change = previous
            ? Math.round(entry.tracera_score.overall - previous.tracera_score.overall)
            : null;
          return (
            <li key={entry.id}>
              <div>
                <p className="trace-history-event">
                  {entry.lineage_reason === "related_story"
                    ? "Appeared through a related submission"
                    : entry.lineage_reason === "scheduled_recheck"
                      ? "Evidence rechecked"
                      : "First checked"}
                </p>
                <time className="trace-history-when" dateTime={entry.created_at}>
                  {new Date(entry.created_at).toLocaleString()}
                </time>
                {entry.source_domain && (
                  <p className="trace-history-where">Seen at {entry.source_domain}</p>
                )}
              </div>
              <p className="trace-history-score">
                {Math.round(entry.tracera_score.overall)}
                {change !== null && (
                  <span
                    className={cn(
                      change === 0
                        ? "text-ink-faint"
                        : change > 0
                          ? "text-tint-lime-foreground"
                          : "text-tint-rose-foreground",
                    )}
                  >
                    {change === 0 ? "unchanged" : `${change > 0 ? "+" : ""}${change}`}
                  </span>
                )}
              </p>
            </li>
          );
        })}
      </ol>

      {repeats.length > 0 && (
        <div className="trace-reasoning">
          <h4>Sent in again</h4>
          <ul>
            {repeats.map((item) => (
              <li key={item.id}>
                {item.source_domain ?? "Pasted text"}, {new Date(item.observed_at).toLocaleString()}
              </li>
            ))}
          </ul>
        </div>
      )}
    </TraceAside>
  );
}
