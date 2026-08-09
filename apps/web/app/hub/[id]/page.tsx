"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import {
  AnalysisResult,
  ScoreCard,
  type ClaimResult,
  type TraceraScore,
} from "../../components/analysis-result";
import { AppHeader } from "../../components/app-header";
import { useAuth } from "../../components/auth-provider";
import {
  GroundZeroCard,
  type GroundZeroTrace,
} from "../../components/ground-zero-card";
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

export default function CheckDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [check, setCheck] = useState<Check | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [appearances, setAppearances] = useState<AppearanceEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { apiFetch } = useAuth();

  useEffect(() => {
    params.then(({ id }) =>
      Promise.all([
        apiFetch(`${apiUrl}/checks/${id}`),
        apiFetch(`${apiUrl}/checks/${id}/timeline`),
        apiFetch(`${apiUrl}/checks/${id}/appearances`),
      ])
        .then(
          async ([checkResponse, timelineResponse, appearancesResponse]) => {
            const [checkData, timelineData, appearancesData] =
              await Promise.all([
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
            if (
              appearancesResponse.ok &&
              Array.isArray(appearancesData.appearances)
            ) {
              setAppearances(appearancesData.appearances);
            }
          },
        )
        .catch((requestError) =>
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Unable to load this check.",
          ),
        ),
    );
  }, [apiFetch, params]);

  return (
    <main className="paper-grid min-h-screen bg-[#f4f6f2] text-emerald-950">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <AppHeader active="hub" />
        {error && (
          <p
            className="mt-10 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
            role="alert"
          >
            {error}
          </p>
        )}
        {!check && !error && (
          <p
            className="mt-10 text-sm font-medium text-emerald-950/55"
            role="status"
          >
            Reassembling the evidence trail…
          </p>
        )}
        {check && (
          <section className="py-12 sm:py-16">
            <Link
              href="/hub"
              className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-sm font-bold text-emerald-800 shadow-sm transition hover:-translate-x-0.5"
            >
              ← Back to News Hub
            </Link>
            <p className="mt-9 text-[10px] font-black uppercase tracking-[0.2em] text-emerald-700">
              Evidence archive · stored check
            </p>
            <h1 className="mt-3 text-5xl font-black tracking-[-.07em] sm:text-6xl">
              The full trace.
            </h1>
            <time
              dateTime={check.createdAt}
              className="mt-3 block text-sm font-medium text-emerald-950/50"
            >
              Checked {new Date(check.createdAt).toLocaleString()}
            </time>
            {(check.sourceDomain || check.publishedAt) && (
              <p className="mt-2 text-sm text-emerald-950/55">
                Source:{" "}
                {check.sourceUrl ? (
                  <a
                    href={check.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-bold text-emerald-800 underline"
                  >
                    {check.sourceDomain ?? check.sourceUrl}
                  </a>
                ) : (
                  check.sourceDomain
                )}
                {check.publishedAt
                  ? ` · published ${new Date(check.publishedAt).toLocaleDateString()}`
                  : ""}
              </p>
            )}
            <div className="mt-8 grid gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-stretch">
              <section className="flex min-h-64 flex-col justify-between rounded-[1.75rem] border border-emerald-950/10 bg-white p-6 shadow-[0_18px_50px_-35px_rgba(16,34,31,.55)] sm:p-8">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-700">
                    Checked statement
                  </p>
                  <blockquote className="mt-5 max-w-3xl text-xl font-bold leading-8 tracking-[-.02em] text-emerald-950 sm:text-2xl sm:leading-9">
                    “{check.rawInput}”
                  </blockquote>
                </div>
                <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-emerald-950/8 pt-5 text-xs font-semibold text-emerald-950/50">
                  <span>
                    {check.analysis.claims.length} atomic{" "}
                    {check.analysis.claims.length === 1 ? "claim" : "claims"}
                  </span>
                  <span>
                    Evidence checked{" "}
                    {new Date(check.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </section>
              <ScoreCard
                score={check.analysis.score ?? check.traceraScore}
                sticky={false}
              />
            </div>
            <AnalysisResult
              claims={check.analysis.claims}
              score={check.analysis.score ?? check.traceraScore}
              showScore={false}
            />
            {check.groundZero && <GroundZeroCard trace={check.groundZero} />}
            <TraceTimeline entries={timeline} appearances={appearances} />
            <AlertSubscription checkId={check.id} />
          </section>
        )}
      </div>
    </main>
  );
}

function AlertSubscription({ checkId }: { checkId: string }) {
  const { apiFetch } = useAuth();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  async function subscribe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus(null);
    const response = await apiFetch(`${apiUrl}/checks/${checkId}/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await response.json();
    setStatus(
      response.ok
        ? "You’ll be notified when this trace materially changes."
        : (data.error ?? "Could not save your alert."),
    );
    if (response.ok) setSubscribed(true);
  }
  async function unsubscribe() {
    const response = await apiFetch(`${apiUrl}/checks/${checkId}/alerts`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setStatus(
      response.ok
        ? "Alert paused for this trace."
        : "Could not pause your alert.",
    );
    if (response.ok) setSubscribed(false);
  }
  return (
    <form
      onSubmit={subscribe}
      className="mt-8 rounded-[1.75rem] border border-emerald-950/10 bg-white p-6 shadow-[0_18px_50px_-35px_rgba(16,34,31,.4)] sm:flex sm:items-center sm:gap-6 sm:p-8"
    >
      <div className="min-w-52 flex-1">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-700">
          Stay updated
        </p>
        <p className="mt-2 text-xl font-black tracking-[-.035em] text-emerald-950">
          Follow this trace.
        </p>
        <p className="mt-1 text-sm leading-6 text-emerald-950/55">
          Get an email when new evidence materially changes its score.
        </p>
      </div>
      <div className="mt-5 sm:mt-0 sm:w-[28rem]">
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex-1">
            <span className="sr-only">Email address for trace updates</span>
            <input
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-xl border border-emerald-950/10 bg-[#f4f6f2] px-4 py-3 text-sm text-emerald-950 outline-none transition placeholder:text-emerald-950/35 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
            />
          </label>
          <button className="rounded-xl bg-emerald-950 px-5 py-3 text-sm font-black text-white shadow-[3px_3px_0_#8ee8cb] transition hover:-translate-y-0.5">
            {subscribed ? "Alert active" : "Notify me"}
          </button>
        </div>
        <div className="mt-3 flex min-h-5 items-center gap-3">
          {subscribed && (
            <button
              type="button"
              onClick={() => void unsubscribe()}
              className="text-xs font-bold text-emerald-800 underline underline-offset-2"
            >
              Unsubscribe
            </button>
          )}
          {status && <p className="text-xs text-emerald-950/60">{status}</p>}
        </div>
      </div>
    </form>
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
    <section className="mt-8 rounded-[1.75rem] border border-emerald-950/10 bg-white p-6 shadow-[0_18px_50px_-35px_rgba(16,34,31,.4)] sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-700">
            Trace timeline
          </p>
          <h2 className="mt-2 text-2xl font-black tracking-[-.045em]">
            How this check has changed.
          </h2>
        </div>
        <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800">
          {entries.length} {entries.length === 1 ? "version" : "versions"} ·{" "}
          {appearances.length} appearances
        </span>
      </div>
      <ol className="mt-7 space-y-4 border-l-2 border-emerald-100 pl-5">
        {entries.map((entry, index) => {
          const previous = entries[index - 1];
          const change = previous
            ? Math.round(
                entry.tracera_score.overall - previous.tracera_score.overall,
              )
            : null;
          return (
            <li key={entry.id} className="relative">
              <span className="absolute -left-[1.85rem] top-1.5 size-3 rounded-full border-[3px] border-white bg-emerald-500 shadow-sm" />
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-black text-emerald-950">
                  {entry.lineage_reason === "related_story"
                    ? "Story appeared from a related submission"
                    : entry.lineage_reason === "scheduled_recheck"
                      ? "Evidence rechecked"
                      : "First checked"}
                </p>
                <time
                  className="text-xs font-medium text-emerald-950/50"
                  dateTime={entry.created_at}
                >
                  {new Date(entry.created_at).toLocaleString()}
                </time>
              </div>
              <p className="mt-1 text-sm text-emerald-950/65">
                Score{" "}
                <span className="font-bold text-emerald-900">
                  {entry.tracera_score.overall}/100
                </span>
                {change !== null && (
                  <span
                    className={
                      change === 0
                        ? "text-emerald-950/45"
                        : change > 0
                          ? "text-emerald-700"
                          : "text-rose-700"
                    }
                  >
                    {change === 0
                      ? " · unchanged"
                      : ` · ${change > 0 ? "+" : ""}${change} points`}
                  </span>
                )}
              </p>
              {entry.source_domain && (
                <p className="mt-1 text-xs font-medium text-emerald-700">
                  Observed at {entry.source_domain}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {appearances.some(
        (item) => item.occurrence_type === "exact_resubmission",
      ) && (
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
