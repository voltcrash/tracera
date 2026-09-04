"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { ClaimResult, FramingAnalysis, TraceraScore } from "@repo/contracts";
import { AnalysisResult, ScoreCard } from "@/components/analysis/analysis-result";
import { GroundZeroCard, type GroundZeroTrace } from "@/components/analysis/ground-zero-card";
import { AccountRequired } from "@/components/auth/account-required";
import { AppHeader } from "@/components/navigation/app-header";
import { useAuth } from "@/components/providers/auth-provider";
import { apiUrl } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
    <main className="paper-grid min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <AppHeader active="hub" />
        {isAuthLoading && (
          <p className="mt-10 text-sm font-medium text-muted-foreground" role="status">
            Restoring your account…
          </p>
        )}
        {!isAuthLoading && !user && <AccountRequired feature="this News Hub trace" />}
        {!isAuthLoading && user && (
          <>
            {error && (
              <Alert variant="destructive" className="mt-10">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {!check && !error && (
              <div className="mt-10 grid gap-4 md:grid-cols-[1fr_23rem]" role="status">
                <Skeleton className="h-72 rounded-3xl" />
                <Skeleton className="h-72 rounded-3xl bg-primary/12" />
                <span className="sr-only">Reassembling the evidence trail…</span>
              </div>
            )}
            {check && (
              <section className="py-12 sm:py-16">
                <Button asChild variant="outline" size="sm" className="rounded-full">
                  <Link href="/hub">
                    <ArrowLeft />
                    Back to News Hub
                  </Link>
                </Button>
                <div className="mt-9 grid gap-5 lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-stretch">
                  <Card className="trace-statement-card min-h-72 justify-between gap-0 overflow-hidden rounded-3xl p-6 sm:p-8">
                    <div>
                      <blockquote className="max-w-[60ch] text-2xl font-bold leading-snug tracking-[-.025em] sm:text-[1.75rem]">
                        “{check.rawInput}”
                      </blockquote>
                    </div>
                    <Separator className="mt-8" />
                    <dl className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-3 sm:divide-x sm:divide-border">
                      <TraceMeta
                        label="Atomic claims"
                        value={String(check.analysis.claims.length).padStart(2, "0")}
                      />
                      <TraceMeta
                        className="sm:pl-6"
                        label="Checked"
                        value={new Date(check.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      />
                      <TraceMeta
                        label="Source"
                        value={check.sourceDomain ?? "Direct submission"}
                        href={check.sourceUrl}
                        className="sm:pl-6"
                      />
                    </dl>
                  </Card>
                  <ScoreCard score={check.analysis.score ?? check.traceraScore} sticky={false} />
                </div>
                <AnalysisResult
                  claims={check.analysis.claims}
                  score={check.analysis.score ?? check.traceraScore}
                  framing={check.analysis.framing}
                  showScore={false}
                />
                {check.groundZero && <GroundZeroCard trace={check.groundZero} />}
                <div className="mt-5">
                  <TraceTimeline entries={timeline} appearances={appearances} />
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function TraceMeta({
  label,
  value,
  href,
  className,
}: {
  label: string;
  value: string;
  href?: string | null;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      {href ? (
        <dd>
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="mt-1 flex items-center gap-1 text-sm font-semibold text-brand-emerald hover:underline"
            title={value}
          >
            <span className="truncate">{value}</span>
            <ExternalLink className="size-3 shrink-0" />
          </a>
        </dd>
      ) : (
        <dd className="mt-1 truncate text-sm font-semibold" title={value}>
          {value}
        </dd>
      )}
    </div>
  );
}

function TraceTimeline({
  entries,
  appearances,
}: {
  entries: TimelineEntry[];
  appearances: AppearanceEntry[];
}) {
  if (entries.length === 0 && appearances.length === 0) return null;
  return (
    <section className="mt-8 border-t border-border pt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className="text-2xl font-extrabold tracking-[-.03em]">How this check has changed</h2>
        <p className="text-sm text-muted-foreground">
          {entries.length} {entries.length === 1 ? "version" : "versions"}, {appearances.length}{" "}
          {appearances.length === 1 ? "appearance" : "appearances"}
        </p>
      </div>
      <ol className="trace-detail-timeline mt-6 divide-y divide-border pl-5">
        {entries.map((entry, index) => {
          const previous = entries[index - 1];
          const change = previous
            ? Math.round(entry.tracera_score.overall - previous.tracera_score.overall)
            : null;
          return (
            <li key={entry.id} className="relative py-4">
              <span className="absolute -left-[1.62rem] top-6 size-3 rounded-full border-[3px] border-background bg-emerald" />
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">
                    {entry.lineage_reason === "related_story"
                      ? "Story appeared from a related submission"
                      : entry.lineage_reason === "scheduled_recheck"
                        ? "Evidence rechecked"
                        : "First checked"}
                  </p>
                  <time
                    className="mt-1 block text-[10px] font-bold text-muted-foreground"
                    dateTime={entry.created_at}
                  >
                    {new Date(entry.created_at).toLocaleString()}
                  </time>
                </div>
                <div className="text-right">
                  <strong className="block text-xl font-bold tabular-nums tracking-[-.03em]">
                    {entry.tracera_score.overall}
                  </strong>
                  {change !== null && (
                    <span
                      className={cn(
                        "text-xs font-semibold",
                        change === 0
                          ? "text-muted-foreground"
                          : change > 0
                            ? "text-tint-mint-foreground"
                            : "text-tint-rose-foreground",
                      )}
                    >
                      {change === 0 ? "unchanged" : `${change > 0 ? "+" : ""}${change} points`}
                    </span>
                  )}
                </div>
              </div>
              {entry.source_domain && (
                <p className="mt-1 text-xs font-medium text-brand-emerald">
                  Observed at {entry.source_domain}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {appearances.some((item) => item.occurrence_type === "exact_resubmission") && (
        <div className="mt-6">
          <Separator className="mb-5" />
          <p className="text-sm font-semibold">Repeat sightings</p>
          <ul className="mt-3 grid gap-x-6 sm:grid-cols-2">
            {appearances
              .filter((item) => item.occurrence_type === "exact_resubmission")
              .map((item) => (
                <li
                  key={item.id}
                  className="border-b border-border py-2 text-sm text-muted-foreground"
                >
                  {item.source_domain ?? "Direct submission"} —{" "}
                  {new Date(item.observed_at).toLocaleString()}
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}
