"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AccountRequired } from "../components/account-required";
import type { TraceraScore } from "../components/analysis-result";
import { AppHeader } from "../components/app-header";
import { useAuth } from "../components/auth-provider";
import { apiUrl } from "../lib/api";

type CheckSummary = {
  id: string;
  rawInput: string;
  traceraScore: TraceraScore;
  createdAt: string;
  sourceDomain: string | null;
  publishedAt: string | null;
  visibility: "public" | "private";
  reanalysisState: "scheduled" | "review_due";
  appearanceCount: number;
};

type PrimaryFilter = "all" | "high" | "review" | "seen";
type SortOrder = "newest" | "oldest" | "highest" | "lowest";
type PrivacyFilter = "all" | "public" | "private";
type StatusFilter = "all" | "monitoring" | "review";
type ViewMode = "grid" | "list";

const primaryFilters: { value: PrimaryFilter; label: string }[] = [
  { value: "all", label: "All checks" },
  { value: "high", label: "Strong signal" },
  { value: "review", label: "Needs review" },
  { value: "seen", label: "Seen by me" },
];

const sortOptions: { value: SortOrder; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "highest", label: "Highest signal" },
  { value: "lowest", label: "Lowest signal" },
];

export default function HubPage() {
  const { apiFetch, isLoading: isAuthLoading, user } = useAuth();
  const [checks, setChecks] = useState<CheckSummary[]>([]);
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
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
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

  function changeViewMode(next: ViewMode) {
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
        {isAuthLoading && <Loading />}
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
                <Stat
                  value={String(pagination.total || checks.length)}
                  label="Checks in this archive"
                  eyebrow="Archive"
                  icon="archive"
                />
                <Stat
                  value={`${average}/100`}
                  label="Average signal score"
                  eyebrow="Signal"
                  icon="signal"
                />
                <Stat
                  value={String(reviewCount)}
                  label="Need another look"
                  eyebrow="Review queue"
                  icon="review"
                />
                <MediaDietCard />
              </div>
            </div>

            <div className="hub-toolbar mt-7 lg:mt-9">
              <div className="hub-filter-scroll" aria-label="Filter checks">
                {primaryFilters.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setFilter(item.value)}
                    aria-pressed={filter === item.value}
                    className={`hub-filter-tab ${filter === item.value ? "hub-filter-tab-active" : ""}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <label className="hub-sort-control">
                <span>Sort by:</span>
                <select
                  value={sortOrder}
                  onChange={(event) => setSortOrder(event.target.value as SortOrder)}
                  aria-label="Sort checks"
                >
                  {sortOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="hub-view-toggle" role="group" aria-label="Choose trace library view">
                {(["grid", "list"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => changeViewMode(mode)}
                    aria-pressed={viewMode === mode}
                    aria-label={`${mode === "grid" ? "Grid" : "List"} view`}
                    title={`${mode === "grid" ? "Grid" : "List"} view`}
                    className={`hub-view-button ${viewMode === mode ? "hub-view-button-active" : ""}`}
                  >
                    <span className={`hub-view-icon hub-view-icon-${mode}`} aria-hidden="true" />
                  </button>
                ))}
              </div>

              <label className="hub-search-control">
                <span className="sr-only">Search checked items</span>
                <span className="hub-search-icon" aria-hidden="true">
                  ⌕
                </span>
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Search a claim, topic, or story…"
                  type="search"
                />
              </label>

              <button
                type="button"
                onClick={() => setFiltersOpen((open) => !open)}
                aria-expanded={filtersOpen}
                aria-controls="hub-secondary-filters"
                className={`hub-filters-button ${filtersOpen || hasSecondaryFilters ? "hub-filters-button-active" : ""}`}
              >
                Filters
                {hasSecondaryFilters && <span className="hub-filter-dot" />}
                <span aria-hidden="true">▽</span>
              </button>
            </div>

            {filtersOpen && (
              <div id="hub-secondary-filters" className="hub-secondary-filters">
                <FilterGroup
                  label="Visibility"
                  value={privacy}
                  onChange={(value) => setPrivacy(value as PrivacyFilter)}
                  options={[
                    ["all", "Any"],
                    ["public", "Public"],
                    ["private", "Private"],
                  ]}
                />
                <FilterGroup
                  label="Trace status"
                  value={status}
                  onChange={(value) => setStatus(value as StatusFilter)}
                  options={[
                    ["all", "Any"],
                    ["monitoring", "Monitoring"],
                    ["review", "Review due"],
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
              </div>
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

            {loading && <Loading compact viewMode={viewMode} />}
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
                <div
                  className={
                    viewMode === "grid"
                      ? "hub-results-grid mt-5 grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 xl:grid-cols-3 xl:gap-5"
                      : "hub-results-list mt-5"
                  }
                >
                  {visible.map((check, index) => (
                    <HubCheckCard
                      key={check.id}
                      check={check}
                      traceNumber={(pagination.page - 1) * 20 + index + 1}
                      bookmarked={bookmarked.has(check.id)}
                      onToggleBookmark={() => toggleBookmark(check.id)}
                      viewMode={viewMode}
                    />
                  ))}
                </div>

                {pagination.totalPages > 1 && (
                  <div className="mt-6 flex items-center justify-between gap-4 text-sm">
                    <span className="text-emerald-950/55">
                      Page {pagination.page} of {pagination.totalPages}
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={page <= 1}
                        onClick={() => setPage((current) => current - 1)}
                        className="hub-page-button bg-white text-emerald-950"
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        disabled={page >= pagination.totalPages}
                        onClick={() => setPage((current) => current + 1)}
                        className="hub-page-button bg-emerald-950 text-white"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function HubCheckCard({
  check,
  traceNumber,
  bookmarked,
  onToggleBookmark,
  viewMode,
}: {
  check: CheckSummary;
  traceNumber: number;
  bookmarked: boolean;
  onToggleBookmark: () => void;
  viewMode: ViewMode;
}) {
  const score = Math.max(0, Math.min(100, check.traceraScore.overall));
  const scoreTone = score >= 70 ? "strong" : score >= 45 ? "mixed" : "weak";

  if (viewMode === "list") {
    return (
      <article className="hub-list-row group">
        <div className="hub-list-meta min-w-0">
          <span className={`hub-trace-label hub-trace-label-${scoreTone}`}>
            TRACE {String(traceNumber).padStart(2, "0")}
          </span>
          <p
            className="mt-2 truncate text-xs font-bold text-emerald-950/48"
            title={check.sourceDomain ?? "Direct submission"}
          >
            {check.sourceDomain ?? "Direct submission"}
          </p>
        </div>

        <Link
          href={`/hub/${check.id}`}
          className="hub-check-title hub-list-title min-w-0 line-clamp-2 font-black leading-[1.3] tracking-[-.025em] text-emerald-950 outline-offset-4 transition group-hover:text-emerald-700 focus-visible:outline-2 focus-visible:outline-emerald-600"
        >
          {check.rawInput}
        </Link>

        <div className="hub-list-state">
          <div className="flex flex-wrap gap-1.5">
            <CheckStatusPills check={check} />
          </div>
          <CheckDate check={check} />
        </div>

        <div className="hub-list-actions">
          <div
            className="hub-score-ring"
            data-tone={scoreTone}
            style={{ "--score": `${score}%` } as React.CSSProperties}
            aria-label={`Signal score ${check.traceraScore.overall} out of 100`}
          >
            <span>{check.traceraScore.overall}</span>
          </div>
          <BookmarkButton bookmarked={bookmarked} onToggleBookmark={onToggleBookmark} />
          <OpenTraceButton id={check.id} />
        </div>
      </article>
    );
  }

  return (
    <article className="hub-check-card group flex min-h-[16.75rem] min-w-0 flex-col overflow-hidden rounded-[1.5rem] border border-emerald-950/10 bg-white p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <span className={`hub-trace-label hub-trace-label-${scoreTone}`}>
            TRACE {String(traceNumber).padStart(2, "0")}
          </span>
          <p
            className="mt-3 truncate text-xs font-bold text-emerald-950/48"
            title={check.sourceDomain ?? "Direct submission"}
          >
            {check.sourceDomain ?? "Direct submission"}
          </p>
        </div>
        <div
          className="hub-score-ring"
          data-tone={scoreTone}
          style={{ "--score": `${score}%` } as React.CSSProperties}
          aria-label={`Signal score ${check.traceraScore.overall} out of 100`}
        >
          <span>{check.traceraScore.overall}</span>
        </div>
      </div>

      <Link
        href={`/hub/${check.id}`}
        className="hub-check-title mt-5 min-w-0 line-clamp-3 text-lg font-black leading-[1.28] tracking-[-.035em] text-emerald-950 outline-offset-4 transition group-hover:text-emerald-700 focus-visible:outline-2 focus-visible:outline-emerald-600 sm:text-xl"
      >
        {check.rawInput}
      </Link>

      <div className="mt-auto pt-7">
        <div className="flex flex-wrap gap-1.5">
          <CheckStatusPills check={check} />
        </div>

        <div className="mt-4 flex items-center gap-3 border-t border-emerald-950/8 pt-4">
          <CheckDate check={check} className="mr-auto" />
          <BookmarkButton bookmarked={bookmarked} onToggleBookmark={onToggleBookmark} />
          <OpenTraceButton id={check.id} />
        </div>
      </div>
    </article>
  );
}

function CheckStatusPills({ check }: { check: CheckSummary }) {
  return (
    <>
      <StatusPill
        tone={check.reanalysisState === "review_due" ? "amber" : "emerald"}
        label={check.reanalysisState === "review_due" ? "Review due" : "Monitoring"}
      />
      {check.visibility === "private" && <StatusPill tone="slate" label="Private" />}
      {check.appearanceCount > 1 && (
        <StatusPill tone="violet" label={`Seen ${check.appearanceCount}×`} />
      )}
    </>
  );
}

function CheckDate({ check, className = "" }: { check: CheckSummary; className?: string }) {
  return (
    <time
      dateTime={check.createdAt}
      className={`${className} text-[11px] font-bold text-emerald-950/46`}
    >
      {new Date(check.createdAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}
    </time>
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

function OpenTraceButton({ id }: { id: string }) {
  return (
    <Link
      href={`/hub/${id}`}
      aria-label="Open trace"
      className="grid size-9 shrink-0 place-items-center rounded-full bg-[#074b3d] text-sm text-white shadow-[0_7px_18px_-10px_rgba(7,75,61,.9)] transition group-hover:translate-x-1 group-hover:bg-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
    >
      →
    </Link>
  );
}

function FilterGroup({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map(([optionValue, optionLabel]) => (
          <button
            key={optionValue}
            type="button"
            onClick={() => onChange(optionValue)}
            aria-pressed={value === optionValue}
            className={`hub-filter-chip ${value === optionValue ? "hub-filter-chip-active" : ""}`}
          >
            {optionLabel}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function StatusPill({
  tone,
  label,
}: {
  tone: "emerald" | "amber" | "slate" | "violet";
  label: string;
}) {
  const tones = {
    emerald: "bg-emerald-100 text-emerald-800",
    amber: "bg-amber-100 text-amber-800",
    slate: "bg-slate-100 text-slate-700",
    violet: "bg-violet-100 text-violet-800",
  };
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[8px] font-black uppercase tracking-[.08em] ${tones[tone]}`}
    >
      {label}
    </span>
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

function Stat({
  value,
  label,
  eyebrow,
  icon,
}: {
  value: string;
  label: string;
  eyebrow: string;
  icon: "archive" | "signal" | "review";
}) {
  const symbols = { archive: "▣", signal: "≋", review: "●" };
  return (
    <section className="hub-stat-card">
      <div className={`hub-stat-icon hub-stat-icon-${icon}`} aria-hidden="true">
        {symbols[icon]}
      </div>
      <div>
        <p className="text-sm font-black text-emerald-950/74">{eyebrow}</p>
        <p className="mt-2 text-sm text-emerald-950/44">{label}</p>
        <p className="mt-4 text-4xl font-black tracking-[-.07em] text-[#082e27]">{value}</p>
      </div>
    </section>
  );
}

function Loading({
  compact = false,
  viewMode = "grid",
}: {
  compact?: boolean;
  viewMode?: ViewMode;
}) {
  return (
    <div
      className={`${compact ? "mt-5" : "mt-8"} grid grid-cols-[minmax(0,1fr)] gap-4 ${viewMode === "grid" ? "md:grid-cols-2 xl:grid-cols-3" : ""}`}
      role="status"
    >
      {[0, 1, 2].map((item) => (
        <div
          key={item}
          className={`${viewMode === "grid" ? "h-[16.75rem]" : "h-32"} animate-pulse rounded-[1.5rem] border border-emerald-950/8 bg-white/70`}
        />
      ))}
      <span className="sr-only">Loading traces…</span>
    </div>
  );
}
