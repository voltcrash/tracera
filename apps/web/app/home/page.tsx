"use client";

import { FormEvent, useState } from "react";
import { AnalysisResult, type ClaimResult, type TraceraScore } from "../components/analysis-result";
import { AppHeader } from "../components/app-header";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const example = "A new study found that drinking coffee after 2pm doubles the risk of insomnia for all adults.";

export default function Home() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ claims: ClaimResult[]; traceraScore: TraceraScore; cached: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const value = text.trim();
      const response = await fetch(`${apiUrl}/analyze`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isHttpUrl(value) ? { url: value } : { text: value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to analyze this text.");
      setResult(data);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to analyze this text.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="paper-grid min-h-screen bg-[#f4f6f2] text-emerald-950">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <AppHeader active="home" />
        <section className="mx-auto flex min-h-[calc(100vh-10rem)] max-w-3xl flex-col justify-center py-16 sm:py-24">
          <div className="text-center">
            <p className="text-[10px] font-black tracking-[.2em] text-emerald-700">START A TRACE</p>
            <h1 className="mt-4 text-4xl font-black tracking-[-.065em] sm:text-6xl">What would you like to check?</h1>
            <p className="mx-auto mt-4 max-w-lg text-base leading-7 text-emerald-950/60">Paste a claim, headline, article, or link. We’ll trace it back to the evidence.</p>
          </div>

          <form onSubmit={analyze} className="mt-10 rounded-[2rem] border border-emerald-950/10 bg-white p-3 shadow-[0_25px_70px_-42px_rgba(16,34,31,.55)] sm:p-4">
            <label className="sr-only" htmlFor="story-input">Story or claim to analyze</label>
            <textarea id="story-input" value={text} onChange={(event) => setText(event.target.value)} disabled={loading} required rows={5} placeholder="Paste a story, claim, or link…" className="w-full resize-none rounded-[1.35rem] bg-[#f8faf7] p-5 text-base leading-7 outline-none placeholder:text-emerald-950/30 focus:bg-white focus:ring-4 focus:ring-emerald-100 disabled:bg-slate-100 sm:p-6" />
            <div className="flex items-center justify-between gap-4 px-2 pb-2 pt-3 sm:px-3">
              <button type="button" onClick={() => setText(example)} className="text-sm font-bold text-emerald-800 transition hover:text-emerald-600">Try an example</button>
              <button type="submit" disabled={loading || !text.trim()} className="inline-flex items-center gap-2 rounded-xl bg-emerald-950 px-5 py-3 text-sm font-black text-white shadow-[3px_3px_0_#8ee8cb] transition hover:-translate-y-0.5 hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none">{loading ? <><Spinner /> Tracing evidence…</> : <>Analyze <span>→</span></>}</button>
            </div>
          </form>
          <p className="mt-4 text-center text-xs font-medium text-emerald-950/45">Links are detected automatically. Image support is coming soon.</p>

          {loading && <div className="mt-6 flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950" role="status"><Spinner /><span><strong>Tracing sources and checking claims.</strong><br />We&apos;re separating evidence from assertion.</span></div>}
          {error && <p className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" role="alert">{error}</p>}
        </section>
        {result && <section className="pb-16"><div className="mb-2 flex items-center gap-2 text-sm font-bold text-emerald-700"><span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,.15)]" /> Analysis complete {result.cached && <span className="font-medium text-emerald-950/50">· recent matching check</span>}</div><AnalysisResult claims={result.claims} score={result.traceraScore} /></section>}
      </div>
    </main>
  );
}

function Spinner() { return <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />; }

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol);
  } catch {
    return false;
  }
}
