"use client";

import { useEffect, useState } from "react";
import type { ClaimResult, FramingAnalysis, TraceraScore } from "@repo/contracts";
import { TraceAside, TraceReport, type GroundZeroTrace } from "@/components/analysis/trace-report";
import { BackButton } from "@/components/navigation/back-button";
import { useAuth } from "@/components/providers/auth-provider";
import { apiUrl } from "@/lib/api";
import { readSessionCache, writeSessionCache } from "@/lib/session-cache";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Check = {
  id: string;
  rawInput: string;
  headline: string;
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
type TraceDetailResponse = {
  check: Check;
  timeline: TimelineEntry[];
  appearances: AppearanceEntry[];
};

const DETAIL_CACHE_AGE = 10 * 60_000;

export function TraceDetail({ id }: { id: string }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [appearances, setAppearances] = useState<AppearanceEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { apiFetch, isLoading: isAuthLoading, user } = useAuth();

  useEffect(() => {
    if (isAuthLoading || !user || !id) return;
    const cached = readSessionCache<TraceDetailResponse>(user.id, `detail:${id}`, DETAIL_CACHE_AGE);
    if (cached) applyDetail(cached, setCheck, setTimeline, setAppearances);

    const controller = new AbortController();
    void apiFetch(`${apiUrl}/checks/${id}/detail`, { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as TraceDetailResponse & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Unable to load this check.");
        applyDetail(data, setCheck, setTimeline, setAppearances);
        writeSessionCache(user.id, `detail:${id}`, data);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted && !cached) {
          setError(
            requestError instanceof Error ? requestError.message : "Unable to load this check.",
          );
        }
      });
    return () => controller.abort();
  }, [apiFetch, id, isAuthLoading, user]);

  return (
    <main className="trace-page min-h-screen bg-background text-foreground">
      <>
        <BackButton href="/hub" label="Back to News Hub" />
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
            headline={check.headline}
            statement={check.rawInput}
            checkedAt={check.createdAt}
            sourceDomain={check.sourceDomain}
            sourceUrl={check.sourceUrl}
            claims={check.analysis.claims}
            score={check.analysis.score ?? check.traceraScore}
            framing={check.analysis.framing}
            groundZero={check.groundZero}
          >
            <TraceHistory entries={timeline} appearances={appearances} />
          </TraceReport>
        )}
      </>
    </main>
  );
}

function applyDetail(
  data: TraceDetailResponse,
  setCheck: (check: Check) => void,
  setTimeline: (timeline: TimelineEntry[]) => void,
  setAppearances: (appearances: AppearanceEntry[]) => void,
) {
  setCheck(data.check);
  setTimeline(Array.isArray(data.timeline) ? data.timeline : []);
  setAppearances(Array.isArray(data.appearances) ? data.appearances : []);
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
      title="How this check has changed"
      count={`${entries.length} ${entries.length === 1 ? "version" : "versions"}`}
      lede="Evidence keeps arriving after a story is published, so a score is only true for the day it was given."
    >
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
