"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Bookmark, Mail } from "lucide-react";
import { AccountRequired } from "@/components/auth/account-required";
import { AppHeader } from "@/components/navigation/app-header";
import { useAuth } from "@/components/providers/auth-provider";
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
} from "./_components/trace-library";
import { apiUrl } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type PrimaryFilter = "all" | "high" | "review" | "seen";
type SortOrder = "newest" | "oldest" | "highest" | "lowest";
type PrivacyFilter = "all" | "public" | "private";

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
      return matchesPrimary && matchesPrivacy;
    });

    return filtered.sort((a, b) => {
      if (sortOrder === "highest") return b.traceraScore.overall - a.traceraScore.overall;
      if (sortOrder === "lowest") return a.traceraScore.overall - b.traceraScore.overall;
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return sortOrder === "oldest" ? aTime - bTime : bTime - aTime;
    });
  }, [checks, filter, privacy, sortOrder]);

  const average = checks.length
    ? Math.round(checks.reduce((sum, item) => sum + item.traceraScore.overall, 0) / checks.length)
    : 0;
  const reviewCount = checks.filter((item) => item.traceraScore.overall < 70).length;
  const hasSecondaryFilters = privacy !== "all";

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
    <main className="hub-page min-h-screen text-foreground">
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
                  <h1 className="max-w-2xl text-[2.8rem] font-black leading-[.92] tracking-[-.07em] sm:text-6xl xl:text-[4.3rem]">
                    The receipts
                    <span className="block text-mint">stay attached.</span>
                  </h1>
                  <p className="mt-6 max-w-xl text-sm leading-relaxed text-white/70 sm:text-base">
                    Every check is a living evidence trail—not a one-off verdict. Search the
                    archive, reopen the sources, and return when the story changes.
                  </p>
                  <Button asChild variant="mint" size="lg" className="mt-7 rounded-full">
                    <Link href="/home">
                      Start a new trace <ArrowRight />
                    </Link>
                  </Button>
                </div>
              </section>

              <div className="flex flex-col justify-center divide-y divide-border px-1 sm:px-2">
                <TraceStat
                  value={String(pagination.total || checks.length)}
                  label="Checks in this archive"
                  icon="archive"
                />
                <TraceStat value={`${average}/100`} label="Average signal score" icon="signal" />
                <TraceStat value={String(reviewCount)} label="Need another look" icon="review" />
                <MediaDietRow />
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
                  {hasSecondaryFilters && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      onClick={() => setPrivacy("all")}
                    >
                      Clear filters
                    </Button>
                  )}
                </>
              }
            />

            {error && (
              <Alert variant="destructive" className="mt-7">
                <AlertDescription className="flex w-full items-center justify-between gap-4">
                  <span>{error}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRequestVersion((version) => version + 1)}
                  >
                    Try again
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            <div className="mt-8 flex flex-wrap items-center gap-3 sm:mt-10">
              <h2 className="text-2xl font-black tracking-[-.045em] sm:text-[1.7rem]">
                Trace Library
              </h2>
              {!loading && !error && (
                <span className="rounded-full bg-secondary px-3 py-1 text-xs font-bold text-muted-foreground">
                  {visible.length === checks.length
                    ? `${pagination.total} matching checks`
                    : `${visible.length} shown on this page`}
                </span>
              )}
            </div>

            {loading && <TraceLoading compact viewMode={viewMode} />}
            {!loading && !error && visible.length === 0 && (
              <Card className="mt-5 gap-2 border-dashed px-5 py-14 text-center shadow-none">
                <p className="font-black">No traces found.</p>
                <p className="text-sm text-muted-foreground">
                  Try a different search or clear one of your filters.
                </p>
              </Card>
            )}

            {!loading && !error && visible.length > 0 && (
              <>
                <TraceResults viewMode={viewMode}>
                  {visible.map((check) => (
                    <TraceCard
                      key={check.id}
                      trace={check}
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
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={onToggleBookmark}
      aria-pressed={bookmarked}
      aria-label={bookmarked ? "Remove bookmark" : "Bookmark trace"}
      className={cn("rounded-full text-muted-foreground", bookmarked && "text-amber-500")}
    >
      <Bookmark className={cn(bookmarked && "fill-current")} />
    </Button>
  );
}

function MediaDietRow() {
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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-5 last:pb-0">
      <Mail className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">
        Your reading diet, last {report?.periodDays ?? 30} days
      </p>
      <Button
        type="button"
        variant={enabled ? "secondary" : "outline"}
        size="sm"
        className="ml-auto"
        onClick={() => void toggle()}
        disabled={saving}
      >
        {enabled ? "Emailing monthly" : "Email it monthly"}
      </Button>
    </div>
  );
}
