"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AccountRequired } from "../components/account-required";
import { AppHeader } from "../components/app-header";
import { useAuth } from "../components/auth-provider";
import {
  StatusPill,
  TraceCard,
  TraceFilterGroup,
  TraceLoading,
  TracePagination,
  TraceResults,
  TraceStat,
  TraceToolbar,
  type TraceOption,
  type TraceSummary,
  type TraceViewMode,
} from "../components/trace-library";
import { apiUrl } from "../lib/api";

/** A trace this account has analyzed, with when and how often it ran it. */
type HistoryTrace = TraceSummary & {
  analyzedAt: string;
  runCount: number;
};

type HistorySummary = {
  totalTraces: number;
  averageSignal: number | null;
  privateTraces: number;
  reviewDue: number;
  lastAnalyzedAt: string | null;
};

type PrimaryFilter = "all" | "high" | "review" | "repeated";
type SortOrder = "recent" | "earliest" | "highest" | "lowest";
type PrivacyFilter = "all" | "public" | "private";
type StatusFilter = "all" | "monitoring" | "review";

const primaryFilters: TraceOption<PrimaryFilter>[] = [
  { value: "all", label: "Everything" },
  { value: "high", label: "Strong signal" },
  { value: "review", label: "Needs review" },
  { value: "repeated", label: "Rechecked" },
];

const sortOptions: TraceOption<SortOrder>[] = [
  { value: "recent", label: "Recently checked" },
  { value: "earliest", label: "First checked" },
  { value: "highest", label: "Highest signal" },
  { value: "lowest", label: "Lowest signal" },
];

const emptySummary: HistorySummary = {
  totalTraces: 0,
  averageSignal: null,
  privateTraces: 0,
  reviewDue: 0,
  lastAnalyzedAt: null,
};

export default function HistoryPage() {
  const { apiFetch, isLoading: isAuthLoading, user } = useAuth();
  const [traces, setTraces] = useState<HistoryTrace[]>([]);
  const [summary, setSummary] = useState<HistorySummary>(emptySummary);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({
    page: 1,
    totalPages: 1,
    total: 0,
  });
  const [filter, setFilter] = useState<PrimaryFilter>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("recent");
  const [privacy, setPrivacy] = useState<PrivacyFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [viewMode, setViewMode] = useState<TraceViewMode>("list");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    try {
      const savedView = window.localStorage.getItem("tracera-history-view");
      if (savedView === "grid" || savedView === "list") setViewMode(savedView);
    } catch {
      // A malformed browser preference should never block the history.
    }
  }, []);

  useEffect(() => {
    if (isAuthLoading || !user) return;
    const controller = new AbortController();
    const handle = setTimeout(() => {
      setLoading(true);
      setError(null);
      apiFetch(`${apiUrl}/history?page=${page}&pageSize=20&q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? "Unable to load your history.");
          setTraces(data.checks);
          setPagination(data.pagination);
          setSummary(data.summary ?? emptySummary);
        })
        .catch((requestError) => {
          if (controller.signal.aborted) return;
          setError(
            requestError instanceof Error ? requestError.message : "Unable to load your history.",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);

    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [apiFetch, isAuthLoading, page, query, requestVersion, user]);

  const visible = useMemo(() => {
    const filtered = traces.filter((trace) => {
      const score = trace.traceraScore.overall;
      const matchesPrimary =
        filter === "all" ||
        (filter === "high" && score >= 70) ||
        (filter === "review" && score < 70) ||
        (filter === "repeated" && trace.runCount > 1);
      const matchesPrivacy = privacy === "all" || trace.visibility === privacy;
      const matchesStatus =
        status === "all" ||
        (status === "monitoring" && trace.reanalysisState === "scheduled") ||
        (status === "review" && trace.reanalysisState === "review_due");
      return matchesPrimary && matchesPrivacy && matchesStatus;
    });

    return filtered.sort((a, b) => {
      if (sortOrder === "highest") return b.traceraScore.overall - a.traceraScore.overall;
      if (sortOrder === "lowest") return a.traceraScore.overall - b.traceraScore.overall;
      const aTime = new Date(a.analyzedAt).getTime();
      const bTime = new Date(b.analyzedAt).getTime();
      return sortOrder === "earliest" ? aTime - bTime : bTime - aTime;
    });
  }, [filter, privacy, sortOrder, status, traces]);

  const hasSecondaryFilters = privacy !== "all" || status !== "all";
  const isEmptyHistory = summary.totalTraces === 0 && !query;

  function changeViewMode(next: TraceViewMode) {
    setViewMode(next);
    try {
      window.localStorage.setItem("tracera-history-view", next);
    } catch {
      // Keep the selection for this visit if browser storage is disabled.
    }
  }

  return (
    <main className="history-page min-h-screen text-emerald-950">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <AppHeader active="history" />
        {isAuthLoading && <TraceLoading />}
        {!isAuthLoading && !user && <AccountRequired feature="your history" />}
        {!isAuthLoading && user && (
          <section className="pb-16 pt-6 sm:pt-8 lg:pb-24">
            <div className="grid gap-4 lg:grid-cols-[1fr_1fr] xl:gap-5">
              <section className="history-hero noise relative overflow-hidden rounded-[1.5rem] px-6 py-9 text-white sm:px-10 sm:py-11 lg:min-h-[25rem] lg:px-11">
                <div className="history-hero-lines" aria-hidden="true" />
                <div className="relative z-10 flex h-full flex-col items-start justify-center">
                  <p className="text-[10px] font-black tracking-[.19em] text-white/80 sm:text-xs">
                    YOUR HISTORY · PRIVATE TO YOU
                  </p>
                  <h1 className="mt-7 max-w-2xl text-[2.8rem] font-black leading-[.92] tracking-[-.07em] sm:text-6xl xl:text-[4.3rem]">
                    Everything
                    <span className="block text-[#49cf9d]">you&apos;ve checked.</span>
                  </h1>
                  <p className="mt-6 max-w-xl text-sm leading-6 text-white/68 sm:text-base sm:leading-7">
                    Your own record of every story you ran through Tracera, newest check first.
                    Nobody else can see this list—not even the traces you kept public.
                  </p>
                  <div className="mt-7 flex flex-wrap items-center gap-3">
                    <Link
                      href="/home"
                      className="inline-flex min-h-11 items-center gap-3 rounded-full bg-[#4bd09f] px-5 py-3 text-sm font-black text-[#0b3028] shadow-[0_14px_35px_-18px_rgba(58,220,164,.9)] transition hover:-translate-y-0.5 hover:bg-[#69ddb3] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#9cf0d1]"
                    >
                      Check something new <span aria-hidden="true">→</span>
                    </Link>
                    <span className="history-private-note">
                      <span aria-hidden="true">⏻</span> ONLY YOU
                    </span>
                  </div>
                </div>
              </section>

              <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:gap-5">
                <TraceStat
                  value={String(summary.totalTraces)}
                  label="Stories you have checked"
                  eyebrow="Checked"
                  icon="archive"
                />
                <TraceStat
                  value={summary.averageSignal === null ? "—" : `${summary.averageSignal}/100`}
                  label="Average signal you read"
                  eyebrow="Signal"
                  icon="signal"
                />
                <TraceStat
                  value={String(summary.reviewDue)}
                  label="Worth checking again"
                  eyebrow="Review queue"
                  icon="review"
                />
                <TraceStat
                  value={String(summary.privateTraces)}
                  label="Kept out of the News Hub"
                  eyebrow="Private"
                  icon="violet"
                />
              </div>
            </div>

            {!isEmptyHistory && (
              <TraceToolbar
                filters={primaryFilters}
                filter={filter}
                onFilterChange={(value) => setFilter(value as PrimaryFilter)}
                filtersLabel="Filter your history"
                sortOptions={sortOptions}
                sortOrder={sortOrder}
                onSortChange={(value) => setSortOrder(value as SortOrder)}
                viewMode={viewMode}
                onViewModeChange={changeViewMode}
                query={query}
                onQueryChange={(value) => {
                  setQuery(value);
                  setPage(1);
                }}
                searchLabel="Search your history"
                searchPlaceholder="Search something you checked…"
                filtersOpen={filtersOpen}
                onToggleFilters={() => setFiltersOpen((open) => !open)}
                hasSecondaryFilters={hasSecondaryFilters}
                secondaryFilters={
                  <>
                    <TraceFilterGroup
                      label="Visibility"
                      value={privacy}
                      onChange={(value) => setPrivacy(value as PrivacyFilter)}
                      options={[
                        { value: "all", label: "Any" },
                        { value: "public", label: "Public" },
                        { value: "private", label: "Private" },
                      ]}
                    />
                    <TraceFilterGroup
                      label="Trace status"
                      value={status}
                      onChange={(value) => setStatus(value as StatusFilter)}
                      options={[
                        { value: "all", label: "Any" },
                        { value: "monitoring", label: "Monitoring" },
                        { value: "review", label: "Review due" },
                      ]}
                    />
                    {hasSecondaryFilters && (
                      <button
                        type="button"
                        onClick={() => {
                          setPrivacy("all");
                          setStatus("all");
                        }}
                        className="hub-clear-filters"
                      >
                        Clear filters
                      </button>
                    )}
                  </>
                }
              />
            )}

            {error && (
              <div
                className="mt-7 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
                role="alert"
              >
                <div className="flex items-center justify-between gap-4">
                  <span>{error}</span>
                  <button
                    type="button"
                    onClick={() => setRequestVersion((version) => version + 1)}
                    className="shrink-0 rounded-lg border border-rose-300 bg-white px-3 py-2 font-bold transition hover:bg-rose-100"
                  >
                    Try again
                  </button>
                </div>
              </div>
            )}

            <div className="mt-8 flex flex-wrap items-center gap-3 sm:mt-10">
              <h2 className="text-2xl font-black tracking-[-.045em] sm:text-[1.7rem]">
                Your checks
              </h2>
              {!loading && !error && !isEmptyHistory && (
                <span className="rounded-full bg-[#eaf0ec] px-3 py-1 text-xs font-bold text-emerald-950/48">
                  {visible.length === traces.length
                    ? `${pagination.total} matching checks`
                    : `${visible.length} shown on this page`}
                </span>
              )}
              {summary.lastAnalyzedAt && !loading && (
                <span className="text-xs font-bold text-emerald-950/45">
                  Last check{" "}
                  {new Date(summary.lastAnalyzedAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              )}
            </div>

            {loading && <TraceLoading compact viewMode={viewMode} />}

            {!loading && !error && visible.length === 0 && (
              <div className="mt-5 rounded-[1.5rem] border border-dashed border-emerald-950/20 bg-white px-5 py-14 text-center">
                <p className="font-black text-emerald-950">
                  {isEmptyHistory ? "You haven't checked anything yet." : "No checks found."}
                </p>
                <p className="mt-2 text-sm text-emerald-950/55">
                  {isEmptyHistory
                    ? "Analyze a headline, link, or image and it will be waiting here."
                    : "Try a different search or clear one of your filters."}
                </p>
                {isEmptyHistory && (
                  <Link
                    href="/home"
                    className="mt-6 inline-flex items-center gap-2 rounded-xl bg-emerald-950 px-5 py-3 text-sm font-black text-white transition hover:-translate-y-0.5 hover:bg-emerald-800"
                  >
                    Start your first trace <span aria-hidden="true">→</span>
                  </Link>
                )}
              </div>
            )}

            {!loading && !error && visible.length > 0 && (
              <>
                <TraceResults viewMode={viewMode}>
                  {visible.map((trace, index) => (
                    <TraceCard
                      key={trace.id}
                      trace={trace}
                      traceNumber={(pagination.page - 1) * 20 + index + 1}
                      viewMode={viewMode}
                      timestamp={trace.analyzedAt}
                      pills={
                        trace.runCount > 1 ? (
                          <StatusPill tone="ink" label={`You checked ${trace.runCount}×`} />
                        ) : null
                      }
                    />
                  ))}
                </TraceResults>

                <TracePagination
                  page={pagination.page}
                  totalPages={pagination.totalPages}
                  onPageChange={setPage}
                />
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
