"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AccountRequired } from "../components/account-required";
import { AppHeader } from "../components/app-header";
import { useAuth } from "../components/auth-provider";
import {
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

type PrimaryFilter = "all" | "high" | "review" | "seen";
type SortOrder = "newest" | "oldest" | "highest" | "lowest";
type PrivacyFilter = "all" | "public" | "private";
type StatusFilter = "all" | "monitoring" | "review";

const primaryFilters: TraceOption<PrimaryFilter>[] = [
  { value: "all", label: "All checks" },
  { value: "high", label: "Strong signal" },
  { value: "review", label: "Needs review" },
  { value: "seen", label: "Seen by me" },
];

const sortOptions: TraceOption<SortOrder>[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "highest", label: "Highest signal" },
  { value: "lowest", label: "Lowest signal" },
];

export default function HubPage() {
  const { apiFetch, isLoading: isAuthLoading, user } = useAuth();
  const [checks, setChecks] = useState<TraceSummary[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({
    page: 1,
    totalPages: 1,
    total: 0,
  });
  const [filter, setFilter] = useState<PrimaryFilter>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [privacy, setPrivacy] = useState<PrivacyFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [viewMode, setViewMode] = useState<TraceViewMode>("grid");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [bookmarked, setBookmarked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem("tracera-hub-bookmarks") ?? "[]");
      if (Array.isArray(saved)) setBookmarked(new Set(saved));
      const savedView = window.localStorage.getItem("tracera-hub-view");
      if (savedView === "grid" || savedView === "list") {
        setViewMode(savedView);
      }
    } catch {
      // A malformed browser preference should never block the archive.
    }
  }, []);

  useEffect(() => {
    if (isAuthLoading || !user) return;
    const controller = new AbortController();
    const handle = setTimeout(() => {
      setLoading(true);
      setError(null);
      apiFetch(`${apiUrl}/checks?page=${page}&pageSize=20&q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? "Unable to load checks.");
          setChecks(data.checks);
          setPagination(data.pagination);
        })
        .catch((requestError) => {
          if (controller.signal.aborted) return;
          setError(requestError instanceof Error ? requestError.message : "Unable to load checks.");
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
    const filtered = checks.filter((check) => {
      const score = check.traceraScore.overall;
      const matchesPrimary =
        filter === "all" ||
        (filter === "high" && score >= 70) ||
        (filter === "review" && score < 70) ||
        (filter === "seen" && check.appearanceCount > 1);
      const matchesPrivacy = privacy === "all" || check.visibility === privacy;
      const matchesStatus =
        status === "all" ||
        (status === "monitoring" && check.reanalysisState === "scheduled") ||
        (status === "review" && check.reanalysisState === "review_due");
      return matchesPrimary && matchesPrivacy && matchesStatus;
    });

    return filtered.sort((a, b) => {
      if (sortOrder === "highest") return b.traceraScore.overall - a.traceraScore.overall;
      if (sortOrder === "lowest") return a.traceraScore.overall - b.traceraScore.overall;
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return sortOrder === "oldest" ? aTime - bTime : bTime - aTime;
    });
  }, [checks, filter, privacy, sortOrder, status]);

  const average = checks.length
    ? Math.round(checks.reduce((sum, item) => sum + item.traceraScore.overall, 0) / checks.length)
    : 0;
  const reviewCount = checks.filter((item) => item.traceraScore.overall < 70).length;
  const hasSecondaryFilters = privacy !== "all" || status !== "all";

  function toggleBookmark(id: string) {
    setBookmarked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem("tracera-hub-bookmarks", JSON.stringify([...next]));
      } catch {
        // Keep bookmarks usable for this visit if browser storage is disabled.
      }
      return next;
    });
  }

  function changeViewMode(next: TraceViewMode) {
    setViewMode(next);
    try {
      window.localStorage.setItem("tracera-hub-view", next);
    } catch {
      // Keep the selection for this visit if browser storage is disabled.
    }
  }

  return (
    <main className="hub-page min-h-screen text-emerald-950">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <AppHeader active="hub" />
        {isAuthLoading && <TraceLoading />}
        {!isAuthLoading && !user && <AccountRequired feature="the News Hub" />}
        {!isAuthLoading && user && (
          <section className="pb-16 pt-6 sm:pt-8 lg:pb-24">
            <div className="grid gap-4 lg:grid-cols-[1fr_1fr] xl:gap-5">
              <section className="hub-hero noise relative overflow-hidden rounded-[1.5rem] px-6 py-9 text-white sm:px-10 sm:py-11 lg:min-h-[25rem] lg:px-11">
                <div className="hub-hero-grid" aria-hidden="true" />
                <div className="relative z-10 flex h-full flex-col items-start justify-center">
                  <p className="text-[10px] font-black tracking-[.19em] text-white/80 sm:text-xs">
                    THE NEWS HUB · LIVING ARCHIVE
                  </p>
                  <h1 className="mt-7 max-w-2xl text-[2.8rem] font-black leading-[.92] tracking-[-.07em] sm:text-6xl xl:text-[4.3rem]">
                    The receipts
                    <span className="block text-[#49cf9d]">stay attached.</span>
                  </h1>
                  <p className="mt-6 max-w-xl text-sm leading-6 text-white/68 sm:text-base sm:leading-7">
                    Every check is a living evidence trail—not a one-off verdict. Search the
                    archive, reopen the sources, and return when the story changes.
                  </p>
                  <Link
                    href="/home"
                    className="mt-7 inline-flex min-h-11 items-center gap-3 rounded-full bg-[#4bd09f] px-5 py-3 text-sm font-black text-[#0b3028] shadow-[0_14px_35px_-18px_rgba(58,220,164,.9)] transition hover:-translate-y-0.5 hover:bg-[#69ddb3] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#9cf0d1]"
                  >
                    Start a new trace <span aria-hidden="true">→</span>
                  </Link>
                </div>
              </section>

              <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:gap-5">
                <TraceStat
                  value={String(pagination.total || checks.length)}
                  label="Checks in this archive"
                  eyebrow="Archive"
                  icon="archive"
                />
                <TraceStat
                  value={`${average}/100`}
                  label="Average signal score"
                  eyebrow="Signal"
                  icon="signal"
                />
                <TraceStat
                  value={String(reviewCount)}
                  label="Need another look"
                  eyebrow="Review queue"
                  icon="review"
                />
                <MediaDietCard />
              </div>
            </div>

            <TraceToolbar
              filters={primaryFilters}
              filter={filter}
              onFilterChange={(value) => setFilter(value as PrimaryFilter)}
              filtersLabel="Filter checks"
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
              searchLabel="Search checked items"
              searchPlaceholder="Search a claim, topic, or story…"
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
                Trace Library
              </h2>
              {!loading && !error && (
                <span className="rounded-full bg-[#eaf0ec] px-3 py-1 text-xs font-bold text-emerald-950/48">
                  {visible.length === checks.length
                    ? `${pagination.total} matching checks`
                    : `${visible.length} shown on this page`}
                </span>
              )}
            </div>

            {loading && <TraceLoading compact viewMode={viewMode} />}
            {!loading && !error && visible.length === 0 && (
              <div className="mt-5 rounded-[1.5rem] border border-dashed border-emerald-950/20 bg-white px-5 py-14 text-center">
                <p className="font-black text-emerald-950">No traces found.</p>
                <p className="mt-2 text-sm text-emerald-950/55">
                  Try a different search or clear one of your filters.
                </p>
              </div>
            )}

            {!loading && !error && visible.length > 0 && (
              <>
                <TraceResults viewMode={viewMode}>
                  {visible.map((check, index) => (
                    <TraceCard
                      key={check.id}
                      trace={check}
                      traceNumber={(pagination.page - 1) * 20 + index + 1}
                      viewMode={viewMode}
                      actions={
                        <BookmarkButton
                          bookmarked={bookmarked.has(check.id)}
                          onToggleBookmark={() => toggleBookmark(check.id)}
                        />
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

function BookmarkButton({
  bookmarked,
  onToggleBookmark,
}: {
  bookmarked: boolean;
  onToggleBookmark: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggleBookmark}
      aria-pressed={bookmarked}
      aria-label={bookmarked ? "Remove bookmark" : "Bookmark trace"}
      className={`hub-bookmark-button ${bookmarked ? "hub-bookmark-button-active" : ""}`}
    >
      <span aria-hidden="true">{bookmarked ? "◆" : "◇"}</span>
    </button>
  );
}

function MediaDietCard() {
  const { apiFetch } = useAuth();
  const [report, setReport] = useState<{
    periodDays: number;
    totalChecks: number;
    averageSourceReputation: number | null;
    averageSignal: number | null;
  } | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch(`${apiUrl}/reports/media-diet`)
      .then(async (response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data) {
          setReport(data.report);
          setEnabled(Boolean(data.preference?.enabled));
        }
      })
      .catch(() => undefined);
  }, [apiFetch]);

  async function toggle() {
    const next = !enabled;
    setEnabled(next);
    setSaving(true);
    try {
      const response = await apiFetch(`${apiUrl}/reports/media-diet/preferences`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next, frequency: "monthly" }),
      });
      if (!response.ok) setEnabled(!next);
    } catch {
      setEnabled(!next);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="hub-stat-card hub-diet-card">
      <div className="hub-stat-icon hub-stat-icon-violet" aria-hidden="true">
        ▦
      </div>
      <div className="min-w-0">
        <p className="text-sm font-black text-emerald-950/74">
          Your diet · {report?.periodDays ?? 30} days
        </p>
        <p className="mt-2 text-sm text-emerald-950/44">Evidence snapshot</p>
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={saving}
          className="mt-5 text-left text-sm font-black text-[#073d33] transition hover:text-emerald-700 disabled:opacity-50"
        >
          {enabled ? "Monthly report on ✓" : "Email my monthly report →"}
        </button>
      </div>
    </section>
  );
}
