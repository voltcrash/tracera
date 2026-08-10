"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppHeader } from "../components/app-header";
import { AccountRequired } from "../components/account-required";
import { useAuth } from "../components/auth-provider";
import type { TraceraScore } from "../components/analysis-result";
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
  const [filter, setFilter] = useState<"all" | "high" | "review">("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestVersion, setRequestVersion] = useState(0);
  useEffect(() => {
    if (isAuthLoading || !user) return;
    const controller = new AbortController();
    const handle = setTimeout(() => {
      setLoading(true);
      setError(null);
      apiFetch(
        `${apiUrl}/checks?page=${page}&pageSize=20&q=${encodeURIComponent(query)}`,
        { signal: controller.signal },
      )
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error ?? "Unable to load checks.");
          setChecks(data.checks);
          setPagination(data.pagination);
        })
        .catch((requestError) => {
          if (controller.signal.aborted) return;
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Unable to load checks.",
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
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <AppHeader active="hub" />
        {isAuthLoading && <Loading />}
        {!isAuthLoading && !user && <AccountRequired feature="the News Hub" />}
        {!isAuthLoading && user && (
          <section className="py-12 sm:py-16">
            <div className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
              <div className="rounded-[2rem] border border-emerald-950/10 bg-white/78 p-7 shadow-[0_28px_65px_-48px_rgba(16,34,31,.62)] sm:p-9">
                <p className="text-[10px] font-black tracking-[.2em] text-emerald-700">
                  THE NEWS HUB · LIVING ARCHIVE
                </p>
                <h1 className="mt-4 max-w-2xl text-5xl font-black leading-[.92] tracking-[-.075em] sm:text-6xl">
                  The receipts
                  <span className="block text-emerald-600">stay attached.</span>
                </h1>
                <p className="mt-5 max-w-xl text-base leading-7 text-emerald-950/58">
                  Every check is a living evidence trail—not a one-off verdict.
                  Search the archive, reopen the sources, and return when the
                  story changes.
                </p>
                <Link
                  href="/home"
                  className="mt-7 inline-flex items-center gap-2 rounded-xl bg-emerald-950 px-5 py-3.5 text-sm font-black text-white shadow-[3px_3px_0_#8ee8cb] transition hover:-translate-y-0.5 hover:bg-emerald-800"
                >
                  Start a new trace <span>→</span>
                </Link>
              </div>
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
                <Stat
                  value={String(checks.length).padStart(2, "0")}
                  label="checks in this view"
                  eyebrow="Archive"
                  tone="mint"
                />
                <Stat
                  value={`${average}/100`}
                  label="average signal score"
                  eyebrow="Signal"
                  tone="dark"
                />
                <Stat
                  value={String(
                    checks.filter((item) => item.traceraScore.overall < 70)
                      .length,
                  ).padStart(2, "0")}
                  label="need another look"
                  eyebrow="Review queue"
                  tone="amber"
                />
              </div>
            </div>
            {user && <MediaDietCard />}
            <div className="mt-8 rounded-[1.75rem] border border-emerald-950/10 bg-white p-3 shadow-[0_20px_60px_-42px_rgba(16,34,31,.6)] sm:p-4">
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
              <div
                className="mt-8 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
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
            {!loading && !error && visible.length === 0 && (
              <p className="mt-8 rounded-3xl border border-dashed border-emerald-950/20 bg-white p-10 text-center text-emerald-950/60">
                No checks match this view.
              </p>
            )}
            {visible.length > 0 && (
              <>
                <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-black tracking-[.18em] text-emerald-700">
                      TRACE LIBRARY
                    </p>
                    <h2 className="mt-2 text-2xl font-black tracking-[-.045em]">
                      Every story keeps its evidence.
                    </h2>
                  </div>
                  <span className="text-xs font-bold text-emerald-950/42">
                    {pagination.total} matching checks
                  </span>
                </div>
                <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {visible.map((check, index) => (
                    <HubCheckCard key={check.id} check={check} index={index} />
                  ))}
                </div>
                <div className="mt-4 flex items-center justify-between text-sm">
                  <span className="text-emerald-950/55">
                    Page {pagination.page} of {pagination.totalPages}
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
        )}
      </div>
    </main>
  );
}

function HubCheckCard({
  check,
  index,
}: {
  check: CheckSummary;
  index: number;
}) {
  const score = Math.max(0, Math.min(100, check.traceraScore.overall));
  const surfaces = ["bg-white", "bg-[#dff7ed]", "bg-[#f1ebfb]", "bg-[#f9ead3]"];
  const scoreColor =
    score >= 70 ? "#34d399" : score >= 45 ? "#f5c451" : "#fb7185";
  return (
    <Link
      href={`/hub/${check.id}`}
      className={`hub-check-card landing-view-reveal group flex min-h-72 flex-col rounded-[1.75rem] border border-emerald-950/10 p-5 shadow-[0_22px_55px_-45px_rgba(16,34,31,.62)] ${surfaces[index % surfaces.length]}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[9px] font-black tracking-[.16em] text-emerald-700">
            TRACE {String(index + 1).padStart(2, "0")}
          </p>
          <p className="mt-1 text-[10px] font-bold text-emerald-950/38">
            {check.sourceDomain ?? "Direct submission"}
          </p>
        </div>
        <div
          className="hub-score-ring"
          style={{
            background: `conic-gradient(${scoreColor} 0 ${score}%, rgba(16,34,31,.08) ${score}% 100%)`,
          }}
          aria-label={`Score ${check.traceraScore.overall} out of 100`}
        >
          <span>{check.traceraScore.overall}</span>
        </div>
      </div>
      <h3 className="mt-7 line-clamp-4 text-lg font-black leading-6 tracking-[-.025em] text-emerald-950 transition group-hover:text-emerald-700">
        {check.rawInput}
      </h3>
      <div className="mt-auto pt-7">
        <div className="flex flex-wrap gap-1.5">
          <StatusPill
            tone={check.reanalysisState === "review_due" ? "amber" : "emerald"}
            label={
              check.reanalysisState === "review_due"
                ? "Review due"
                : "Monitoring"
            }
          />
          {check.visibility === "private" && (
            <StatusPill tone="slate" label="Private" />
          )}
          {check.appearanceCount > 1 && (
            <StatusPill
              tone="violet"
              label={`Seen ${check.appearanceCount}×`}
            />
          )}
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-emerald-950/8 pt-4">
          <time
            dateTime={check.createdAt}
            className="text-[10px] font-bold text-emerald-950/42"
          >
            {new Date(check.createdAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </time>
          <span className="grid size-8 place-items-center rounded-full bg-emerald-950 text-sm text-[#9cf0d1] transition group-hover:translate-x-1">
            →
          </span>
        </div>
      </div>
    </Link>
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
    const response = await apiFetch(
      `${apiUrl}/reports/media-diet/preferences`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next, frequency: "monthly" }),
      },
    );
    if (!response.ok) setEnabled(!next);
  }
  if (!report) return null;
  return (
    <section className="noise relative mt-5 overflow-hidden rounded-[1.75rem] bg-[#0e3028] p-5 text-white shadow-[0_24px_60px_-42px_rgba(6,78,59,.75)] sm:p-6">
      <div className="relative z-10 grid gap-5 md:grid-cols-[1fr_auto_auto_auto] md:items-center">
        <div>
          <p className="text-[9px] font-black tracking-[.17em] text-[#9cf0d1]">
            YOUR MEDIA DIET · {report.periodDays} DAYS
          </p>
          <h2 className="mt-2 text-xl font-black tracking-[-.035em]">
            See the pattern behind your checks.
          </h2>
        </div>
        <DietMetric value={String(report.totalChecks)} label="Checks" />
        <DietMetric
          value={`${report.averageSourceReputation ?? "—"}`}
          label="Source quality"
        />
        <DietMetric
          value={`${report.averageSignal ?? "—"}`}
          label="Avg. signal"
        />
      </div>
      <div className="relative z-10 mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
        <p className="text-xs text-white/48">
          A monthly snapshot of the evidence you inspect.
        </p>
        <button
          onClick={() => void toggle()}
          className="rounded-xl bg-[#9cf0d1] px-4 py-2.5 text-xs font-black text-emerald-950 transition hover:-translate-y-0.5"
        >
          {enabled ? "Monthly report on ✓" : "Email my monthly report"}
        </button>
      </div>
    </section>
  );
}

function DietMetric({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-white/[.07] px-4 py-3">
      <strong className="block text-xl font-black tracking-[-.05em] text-[#9cf0d1]">
        {value}
      </strong>
      <span className="mt-1 block text-[8px] font-black uppercase tracking-[.11em] text-white/38">
        {label}
      </span>
    </div>
  );
}

function Loading() {
  return (
    <div
      className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3"
      role="status"
    >
      {[0, 1, 2].map((item) => (
        <div
          key={item}
          className="h-72 animate-pulse rounded-[1.75rem] border border-emerald-950/8 bg-white/70"
        />
      ))}
      <span className="sr-only">Loading traces…</span>
    </div>
  );
}
function Stat({
  value,
  label,
  eyebrow,
  tone,
}: {
  value: string;
  label: string;
  eyebrow: string;
  tone: "mint" | "dark" | "amber";
}) {
  const tones = {
    mint: "border-emerald-800/10 bg-[#dff7ed] text-emerald-950",
    dark: "border-transparent bg-[#0e3028] text-white",
    amber: "border-amber-900/10 bg-[#fae8ce] text-emerald-950",
  };
  return (
    <div
      className={`flex items-center justify-between gap-5 rounded-[1.5rem] border p-5 ${tones[tone]}`}
    >
      <div>
        <p
          className={`text-[8px] font-black uppercase tracking-[.15em] ${tone === "dark" ? "text-[#9cf0d1]" : "text-emerald-700"}`}
        >
          {eyebrow}
        </p>
        <p
          className={`mt-2 text-[10px] font-bold uppercase tracking-[.08em] ${tone === "dark" ? "text-white/45" : "text-emerald-950/45"}`}
        >
          {label}
        </p>
      </div>
      <p
        className={`text-3xl font-black tracking-[-.07em] ${tone === "dark" ? "text-[#9cf0d1]" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}
