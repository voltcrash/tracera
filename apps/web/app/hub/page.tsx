"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppHeader } from "../components/app-header";
import { useAuth } from "../components/auth-provider";
import type { TraceraScore } from "../components/analysis-result";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
type CheckSummary = {
  id: string;
  rawInput: string;
  traceraScore: TraceraScore;
  createdAt: string;
  sourceDomain: string | null;
  publishedAt: string | null;
  visibility: "public" | "private";
  reanalysisState: "scheduled" | "review_due";
};

export default function HubPage() {
  const { user } = useAuth();
  const [checks, setChecks] = useState<CheckSummary[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({
    page: 1,
    totalPages: 1,
    total: 0,
  });
  const [filter, setFilter] = useState<"all" | "high" | "review">("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const handle = setTimeout(() => {
      setLoading(true);
      fetch(
        `${apiUrl}/checks?page=${page}&pageSize=20&q=${encodeURIComponent(query)}`,
        { credentials: "include" },
      )
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error ?? "Unable to load checks.");
          setChecks(data.checks);
          setPagination(data.pagination);
        })
        .catch((requestError) =>
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Unable to load checks.",
          ),
        )
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [page, query]);
  const visible = useMemo(
    () =>
      checks.filter(
        (check) =>
          filter === "all" ||
          (filter === "high"
            ? check.traceraScore.overall >= 70
            : check.traceraScore.overall < 70),
      ),
    [checks, filter],
  );
  const average = checks.length
    ? Math.round(
        checks.reduce((sum, item) => sum + item.traceraScore.overall, 0) /
          checks.length,
      )
    : 0;

  return (
    <main className="paper-grid min-h-screen bg-[#f4f6f2] text-emerald-950">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <AppHeader active="hub" />
        <section className="py-12 sm:py-16">
          <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <p className="text-[10px] font-black tracking-[.2em] text-emerald-700">
                THE NEWS HUB
              </p>
              <h1 className="mt-3 max-w-xl text-5xl font-black leading-[.96] tracking-[-.07em] sm:text-6xl">
                The receipts
                <br />
                <span className="text-emerald-600">stay attached.</span>
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-8 text-emerald-950/60">
                Every check is a living evidence trail—not a one-off verdict.
                Return when the story changes.
              </p>
            </div>
            <Link
              href="/"
              className="w-fit rounded-xl bg-emerald-950 px-4 py-3 text-sm font-black text-white shadow-[3px_3px_0_#8ee8cb] transition hover:-translate-y-0.5"
            >
              Start a new trace →
            </Link>
          </div>
          <div className="mt-10 grid gap-3 sm:grid-cols-3">
            <Stat
              value={String(checks.length).padStart(2, "0")}
              label="checks in the archive"
            />
            <Stat value={`${average}/100`} label="average signal score" />
            <Stat
              value={String(
                checks.filter((item) => item.traceraScore.overall < 70).length,
              ).padStart(2, "0")}
              label="need a second look"
            />
          </div>
          {user && <MediaDietCard />}
          <div className="mt-10 rounded-[1.75rem] border border-emerald-950/10 bg-white p-3 shadow-[0_20px_60px_-42px_rgba(16,34,31,.6)] sm:p-4">
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <label className="relative">
                <span className="sr-only">Search checked items</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search a claim, topic, or story…"
                  className="w-full rounded-xl bg-[#f5f8f4] px-4 py-3 pl-11 text-sm outline-none placeholder:text-emerald-950/35 focus:ring-4 focus:ring-emerald-100"
                />
                <span className="absolute left-4 top-3 text-lg text-emerald-800/40">
                  ⌕
                </span>
              </label>
              <div className="flex rounded-xl bg-[#f5f8f4] p-1">
                {(["all", "high", "review"] as const).map((item) => (
                  <button
                    key={item}
                    onClick={() => setFilter(item)}
                    className={`rounded-lg px-3 py-2 text-xs font-black transition ${filter === item ? "bg-emerald-950 text-white shadow-sm" : "text-emerald-950/50 hover:text-emerald-950"}`}
                  >
                    {item === "all"
                      ? "All checks"
                      : item === "high"
                        ? "Strong signal"
                        : "Needs review"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {loading && <Loading />}
          {error && (
            <p
              className="mt-8 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
              role="alert"
            >
              {error}
            </p>
          )}
          {!loading && !error && visible.length === 0 && (
            <p className="mt-8 rounded-3xl border border-dashed border-emerald-950/20 bg-white p-10 text-center text-emerald-950/60">
              No checks match this view.
            </p>
          )}
          {visible.length > 0 && (
            <>
              <div className="mt-5 overflow-hidden rounded-[1.75rem] border border-emerald-950/10 bg-white shadow-[0_20px_60px_-42px_rgba(16,34,31,.6)]">
                <div className="hidden grid-cols-[1fr_9rem_8rem_1.5rem] gap-4 border-b border-emerald-950/8 bg-emerald-950/[.03] px-6 py-3 text-[10px] font-black tracking-[.14em] text-emerald-950/45 sm:grid">
                  <span>CHECKED TEXT</span>
                  <span>SOURCE · STATUS</span>
                  <span>LAST CHECKED</span>
                  <span />
                </div>
                {visible.map((check) => (
                  <Link
                    key={check.id}
                    href={`/hub/${check.id}`}
                    className="group grid gap-3 border-b border-emerald-950/8 px-5 py-5 transition last:border-0 hover:bg-emerald-50/60 sm:grid-cols-[1fr_9rem_8rem_1.5rem] sm:items-center sm:gap-4 sm:px-6"
                  >
                    <p className="line-clamp-2 text-sm font-bold leading-6 text-emerald-950 group-hover:text-emerald-700">
                      {check.rawInput}
                    </p>
                    <div>
                      <Score value={check.traceraScore.overall} />
                      <p className="mt-1 text-[10px] font-bold text-emerald-950/45">
                        {check.sourceDomain ?? "Direct submission"} ·{" "}
                        {check.reanalysisState === "review_due"
                          ? "re-analysis due"
                          : "monitoring"}
                        {check.visibility === "private" ? " · private" : ""}
                      </p>
                    </div>
                    <time
                      dateTime={check.createdAt}
                      className="text-sm font-medium text-emerald-950/45"
                    >
                      {new Date(check.createdAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </time>
                    <span className="hidden text-xl text-emerald-700 transition group-hover:translate-x-1 sm:block">
                      →
                    </span>
                  </Link>
                ))}
              </div>
              <div className="mt-4 flex items-center justify-between text-sm">
                <span className="text-emerald-950/55">
                  {pagination.total} matching checks
                </span>
                <div className="flex gap-2">
                  <button
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                    className="rounded-lg bg-white px-3 py-2 font-bold disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    disabled={page >= pagination.totalPages}
                    onClick={() => setPage(page + 1)}
                    className="rounded-lg bg-emerald-950 px-3 py-2 font-bold text-white disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function MediaDietCard() {
  const [report, setReport] = useState<{
    periodDays: number;
    totalChecks: number;
    averageSourceReputation: number | null;
    averageSignal: number | null;
  } | null>(null);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    fetch(`${apiUrl}/reports/media-diet`, { credentials: "include" })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data) {
          setReport(data.report);
          setEnabled(Boolean(data.preference?.enabled));
        }
      })
      .catch(() => undefined);
  }, []);
  async function toggle() {
    const next = !enabled;
    setEnabled(next);
    const response = await fetch(`${apiUrl}/reports/media-diet/preferences`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: next, frequency: "monthly" }),
    });
    if (!response.ok) setEnabled(!next);
  }
  if (!report) return null;
  return (
    <section className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-emerald-950/10 bg-emerald-950 p-5 text-white">
      <div>
        <p className="text-[10px] font-black tracking-[.16em] text-[#9cf0d1]">
          YOUR MEDIA DIET · {report.periodDays} DAYS
        </p>
        <p className="mt-1 text-sm text-white/75">
          {report.totalChecks} checks · source reputation{" "}
          {report.averageSourceReputation ?? "—"}/100 · signal{" "}
          {report.averageSignal ?? "—"}/100
        </p>
      </div>
      <button
        onClick={() => void toggle()}
        className="rounded-xl bg-[#9cf0d1] px-4 py-2 text-sm font-black text-emerald-950"
      >
        {enabled ? "Monthly email on" : "Email me this report"}
      </button>
    </section>
  );
}
function Loading() {
  return (
    <div className="mt-6 space-y-3" role="status">
      <div className="h-24 animate-pulse rounded-3xl bg-emerald-950/10" />
      <div className="h-24 animate-pulse rounded-3xl bg-emerald-950/10" />
    </div>
  );
}
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl border border-emerald-950/10 bg-white/65 p-5">
      <p className="text-3xl font-black tracking-[-.06em]">{value}</p>
      <p className="mt-1 text-xs font-bold uppercase tracking-[.1em] text-emerald-950/45">
        {label}
      </p>
    </div>
  );
}
function Score({ value }: { value: number }) {
  const style =
    value >= 70
      ? "bg-emerald-100 text-emerald-800"
      : value >= 45
        ? "bg-amber-100 text-amber-800"
        : "bg-rose-100 text-rose-800";
  return (
    <span
      className={`w-fit rounded-full px-3 py-1.5 text-sm font-black ${style}`}
    >
      {value}/100
    </span>
  );
}
