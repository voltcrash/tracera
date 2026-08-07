"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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
};

export default function CheckDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    params.then(({ id }) =>
      fetch(`${apiUrl}/checks/${id}`)
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error ?? "Unable to load this check.");
          setCheck(data.check);
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
          <p className="mt-10 text-sm font-medium text-emerald-950/55" role="status">
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
            <blockquote className="mt-8 rounded-[1.75rem] border border-emerald-950/10 border-l-4 border-l-emerald-500 bg-white p-6 text-base leading-7 text-emerald-950/75 shadow-[0_18px_50px_-35px_rgba(16,34,31,.55)] sm:p-8">
              {check.rawInput}
            </blockquote>
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
