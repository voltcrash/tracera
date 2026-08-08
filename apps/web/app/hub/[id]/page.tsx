"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import {
  AnalysisResult,
  type ClaimResult,
  type TraceraScore,
} from "../../components/analysis-result";
import { AppHeader } from "../../components/app-header";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
type Check = {
  id: string;
  rawInput: string;
  createdAt: string;
  traceraScore: TraceraScore;
  analysis: { claims: ClaimResult[]; score: TraceraScore };
  sourceDomain: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  groundZero?: {
    confidence: string;
    earliestSource: { title: string; url?: string } | null;
  };
};
type TimelineEntry = {
  id: string;
  supersedes_check_id: string | null;
  tracera_score: TraceraScore;
  created_at: string;
};

export default function CheckDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [check, setCheck] = useState<Check | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    params.then(({ id }) =>
      Promise.all([
        fetch(`${apiUrl}/checks/${id}`, { credentials: "include" }),
        fetch(`${apiUrl}/checks/${id}/timeline`, { credentials: "include" }),
      ])
        .then(async ([checkResponse, timelineResponse]) => {
          const [checkData, timelineData] = await Promise.all([
            checkResponse.json(),
            timelineResponse.json(),
          ]);
          if (!checkResponse.ok) {
            throw new Error(checkData.error ?? "Unable to load this check.");
          }
          setCheck(checkData.check);
          if (timelineResponse.ok && Array.isArray(timelineData.timeline)) {
            setTimeline(timelineData.timeline);
          }
        })
        .catch((requestError) =>
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Unable to load this check.",
          ),
        ),
    );
  }, [params]);

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
            <blockquote className="mt-8 rounded-[1.75rem] border border-emerald-950/10 border-l-4 border-l-emerald-500 bg-white p-6 text-base leading-7 text-emerald-950/75 shadow-[0_18px_50px_-35px_rgba(16,34,31,.55)] sm:p-8">
              {check.rawInput}
            </blockquote>
            <AlertSubscription checkId={check.id} />
            <TraceTimeline entries={timeline} />
            <AnalysisResult
              claims={check.analysis.claims}
              score={check.analysis.score ?? check.traceraScore}
            />
          </section>
        )}
      </div>
    </main>
  );
}

function AlertSubscription({ checkId }: { checkId: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  async function subscribe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus(null);
    const response = await fetch(`${apiUrl}/checks/${checkId}/alerts`, {
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
    const response = await fetch(`${apiUrl}/checks/${checkId}/alerts`, {
      method: "DELETE",
      credentials: "include",
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
      className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl bg-emerald-950 p-4 text-white"
    >
      <div className="min-w-52 flex-1">
        <p className="text-sm font-black">Follow this trace</p>
        <p className="text-xs text-white/65">
          Get an email when new evidence materially changes its score.
        </p>
      </div>
      <input
        required
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@example.com"
        className="rounded-xl px-3 py-2 text-sm text-emerald-950 outline-none"
      />
      <button className="rounded-xl bg-[#9cf0d1] px-4 py-2 text-sm font-black text-emerald-950">
        {subscribed ? "Alert active" : "Notify me"}
      </button>
      {subscribed && (
        <button
          type="button"
          onClick={() => void unsubscribe()}
          className="text-xs font-bold text-white/75 underline"
        >
          Unsubscribe
        </button>
      )}
      {status && <p className="w-full text-xs text-white/80">{status}</p>}
    </form>
  );
}

function TraceTimeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return null;
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
          {entries.length} {entries.length === 1 ? "version" : "versions"}
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
                  {index === 0 ? "First checked" : "Evidence rechecked"}
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
            </li>
          );
        })}
      </ol>
    </section>
  );
}
