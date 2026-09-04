"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { ClaimResult, TraceraScore } from "@repo/contracts";
import { AnalysisResult, ScoreCard } from "../../components/analysis-result";
import { AppHeader } from "../../components/app-header";
import { AccountRequired } from "../../components/account-required";
import { useAuth } from "../../components/auth-provider";
import { GroundZeroCard, type GroundZeroTrace } from "../../components/ground-zero-card";
import { apiUrl } from "../../lib/api";

type Check = {
  id: string;
  rawInput: string;
  createdAt: string;
  traceraScore: TraceraScore;
  analysis: { claims: ClaimResult[]; score: TraceraScore };
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

export function TraceDetail() {
  // The static export renders one shell for every trace, so the check id comes
  // from the browser location instead of a prerendered route parameter.
  const id = decodeURIComponent(usePathname().split("/").pop() ?? "");
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
    <main className="paper-grid min-h-screen bg-[#f4f6f2] text-emerald-950">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <AppHeader active="hub" />
        {isAuthLoading && (
          <p className="mt-10 text-sm font-medium text-emerald-950/55" role="status">
            Restoring your account…
          </p>
        )}
        {!isAuthLoading && !user && <AccountRequired feature="this News Hub trace" />}
        {!isAuthLoading && user && (
          <>
            {error && (
              <p
                className="mt-10 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
                role="alert"
              >
                {error}
              </p>
            )}
            {!check && !error && (
              <div className="mt-10 grid gap-4 md:grid-cols-[1fr_23rem]" role="status">
                <div className="h-72 animate-pulse rounded-[2rem] border border-emerald-950/8 bg-white/70" />
                <div className="h-72 animate-pulse rounded-[2rem] bg-emerald-950/12" />
                <span className="sr-only">Reassembling the evidence trail…</span>
              </div>
            )}
            {check && (
              <section className="py-12 sm:py-16">
                <Link
                  href="/hub"
                  className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-sm font-bold text-emerald-800 shadow-sm transition hover:-translate-x-0.5"
                >
                  ← Back to News Hub
                </Link>
                <div className="mt-9 grid gap-5 lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-stretch">
                  <section className="trace-statement-card flex min-h-72 flex-col justify-between overflow-hidden rounded-[2rem] border border-emerald-950/10 bg-white p-6 shadow-[0_24px_60px_-42px_rgba(16,34,31,.58)] sm:p-8">
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-700">
                          EVIDENCE ARCHIVE · FULL TRACE
                        </p>
                        <span className="inline-flex items-center gap-2 rounded-full bg-emerald-100 px-3 py-1.5 text-[9px] font-black text-emerald-800">
                          <span className="size-1.5 rounded-full bg-emerald-500" /> STORED CHECK
                        </span>
                      </div>
                      <h1 className="mt-5 text-4xl font-black leading-[.95] tracking-[-.065em] sm:text-5xl">
                        The full trace.
                      </h1>
                      <blockquote className="mt-7 max-w-3xl border-l-2 border-emerald-300 pl-5 text-lg font-bold leading-8 tracking-[-.02em] text-emerald-950/78 sm:text-xl">
                        “{check.rawInput}”
                      </blockquote>
                    </div>
                    <div className="mt-8 grid gap-2 border-t border-emerald-950/8 pt-5 sm:grid-cols-3">
                      <TraceMeta
                        label="Atomic claims"
                        value={String(check.analysis.claims.length).padStart(2, "0")}
                      />
                      <TraceMeta
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
                      />
                    </div>
                  </section>
                  <ScoreCard score={check.analysis.score ?? check.traceraScore} sticky={false} />
                </div>
                <AnalysisResult
                  claims={check.analysis.claims}
                  score={check.analysis.score ?? check.traceraScore}
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

function TraceMeta({ label, value, href }: { label: string; value: string; href?: string | null }) {
  return (
    <div className="rounded-xl bg-[#f3f7f3] px-3 py-2.5">
      <p className="text-[8px] font-black uppercase tracking-[.13em] text-emerald-950/35">
        {label}
      </p>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="mt-1 block truncate text-[10px] font-black text-emerald-800 hover:text-emerald-600"
          title={value}
        >
          {value} ↗
        </a>
      ) : (
        <p className="mt-1 truncate text-[10px] font-black text-emerald-950/72" title={value}>
          {value}
        </p>
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
    <section className="landing-view-reveal rounded-[1.75rem] border border-emerald-950/10 bg-white p-6 shadow-[0_22px_55px_-45px_rgba(16,34,31,.5)] sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-700">
            Trace timeline
          </p>
          <h2 className="mt-2 text-2xl font-black tracking-[-.045em]">
            How this check has changed.
          </h2>
        </div>
        <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-[9px] font-black uppercase tracking-[.08em] text-emerald-800">
          {entries.length} {entries.length === 1 ? "version" : "versions"} · {appearances.length}{" "}
          appearances
        </span>
      </div>
      <ol className="trace-detail-timeline mt-7 space-y-3 pl-5">
        {entries.map((entry, index) => {
          const previous = entries[index - 1];
          const change = previous
            ? Math.round(entry.tracera_score.overall - previous.tracera_score.overall)
            : null;
          return (
            <li key={entry.id} className="relative rounded-2xl bg-[#f3f7f3] p-4">
              <span className="absolute -left-[1.62rem] top-5 size-3 rounded-full border-[3px] border-white bg-emerald-500 shadow-sm" />
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-black text-emerald-950">
                    {entry.lineage_reason === "related_story"
                      ? "Story appeared from a related submission"
                      : entry.lineage_reason === "scheduled_recheck"
                        ? "Evidence rechecked"
                        : "First checked"}
                  </p>
                  <time
                    className="mt-1 block text-[10px] font-bold text-emerald-950/40"
                    dateTime={entry.created_at}
                  >
                    {new Date(entry.created_at).toLocaleString()}
                  </time>
                </div>
                <div className="text-right">
                  <strong className="block text-xl tracking-[-.05em] text-emerald-900">
                    {entry.tracera_score.overall}
                  </strong>
                  {change !== null && (
                    <span
                      className={`text-[9px] font-black ${
                        change === 0
                          ? "text-emerald-950/45"
                          : change > 0
                            ? "text-emerald-700"
                            : "text-rose-700"
                      }`}
                    >
                      {change === 0 ? " · unchanged" : `${change > 0 ? "+" : ""}${change} PTS`}
                    </span>
                  )}
                </div>
              </div>
              {entry.source_domain && (
                <p className="mt-1 text-xs font-medium text-emerald-700">
                  Observed at {entry.source_domain}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {appearances.some((item) => item.occurrence_type === "exact_resubmission") && (
        <div className="mt-6 border-t border-emerald-950/8 pt-5">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-emerald-700">
            Repeat sightings
          </p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {appearances
              .filter((item) => item.occurrence_type === "exact_resubmission")
              .map((item) => (
                <li
                  key={item.id}
                  className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-950/65"
                >
                  {item.source_domain ?? "Direct submission"} ·{" "}
                  {new Date(item.observed_at).toLocaleString()}
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}
