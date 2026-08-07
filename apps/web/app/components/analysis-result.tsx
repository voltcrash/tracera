"use client";

export type ScoreDimension = { score: number; label: string };

export type TraceraScore = {
  overall: number;
  factualAccuracy: ScoreDimension;
  sourceCorroboration: ScoreDimension;
  framingManipulation: ScoreDimension;
  evidenceQuality: ScoreDimension;
  sourceReputation?: ScoreDimension;
  recency: { flag: string; newestEvidenceAt: string | null };
};

export type ClaimResult = {
  claim: {
    id: string;
    claimText: string;
    claimType: string;
    checkability: string;
    context?: string;
  };
  verdict: string;
  confidence: number;
  reasoning: string[];
  evidenceQuality?: number;
  consideredSources?: EvidenceSource[];
  supportingSources?: EvidenceSource[];
  contradictingSources?: EvidenceSource[];
};

type EvidenceSource = {
  id: string;
  title: string;
  publisher?: string;
  url?: string;
  snippet?: string;
  publishedAt?: string;
};

export function AnalysisResult({
  claims,
  score,
}: {
  claims: ClaimResult[];
  score: TraceraScore;
}) {
  return (
    <section className="mt-8 grid gap-6 lg:grid-cols-[1fr_21rem]">
      <div className="order-2 lg:order-1">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs font-black tracking-[0.18em] text-emerald-800">
              CLAIM MAP · {claims.length} SIGNALS
            </p>
            <h2 className="mt-1 text-xl font-bold tracking-tight text-slate-950">
              Story, separated from spin.
            </h2>
          </div>
          <span className="hidden text-sm font-medium text-emerald-950/55 sm:block">
            Read each verdict independently
          </span>
        </div>
        <div className="mt-3 space-y-3">
          {claims.map((item, index) => (
            <article
              key={item.claim.id || index}
              className="group rounded-3xl border border-emerald-950/10 bg-white p-5 shadow-[0_8px_30px_-18px_rgba(16,34,31,.3)] transition hover:-translate-y-0.5 hover:border-emerald-800/30"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="max-w-xl text-[15px] font-bold leading-6 text-emerald-950">
                  {item.claim.claimText}
                </p>
                <Verdict verdict={item.verdict} />
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-bold uppercase tracking-[.12em] text-emerald-950/55">
                <span className="rounded-full bg-emerald-950/5 px-2.5 py-1">
                  Confidence {Math.round(item.confidence * 100)}%
                </span>
                <span className="rounded-full bg-emerald-950/5 px-2.5 py-1">
                  {item.claim.checkability.replaceAll("_", " ")}
                </span>
                {typeof item.evidenceQuality === "number" && (
                  <span className="rounded-full bg-emerald-950/5 px-2.5 py-1">
                    {Math.round(item.evidenceQuality * 100)}% evidence quality
                  </span>
                )}
              </div>
              {item.reasoning.length > 0 && (
                <ul className="mt-4 space-y-2 text-sm leading-6 text-emerald-950/70">
                  {item.reasoning.map((reason, reasonIndex) => (
                    <li key={reasonIndex} className="flex gap-2">
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-emerald-500" />
                      {reason}
                    </li>
                  ))}
                </ul>
              )}
              {item.consideredSources?.length ||
              item.supportingSources?.length ||
              item.contradictingSources?.length ? (
                <div className="mt-5 border-t border-emerald-950/8 pt-4">
                  <p className="text-[10px] font-black tracking-[.16em] text-emerald-950/45">
                    {item.supportingSources?.length ||
                    item.contradictingSources?.length
                      ? "EVIDENCE SOURCES"
                      : "SOURCES REVIEWED — NOT ENOUGH TO VERIFY"}
                  </p>
                  <div className="mt-2 space-y-2">
                    {[
                      ...(item.supportingSources ?? []),
                      ...(item.contradictingSources ?? []),
                      ...(item.consideredSources ?? []),
                    ]
                      .filter(
                        (source, sourceIndex, sources) =>
                          sources.findIndex(
                            (candidate) => candidate.id === source.id,
                          ) === sourceIndex,
                      )
                      .slice(0, 5)
                      .map((source) => (
                        <a
                          key={source.id}
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block rounded-xl bg-emerald-50/70 px-3 py-2 text-sm font-medium text-emerald-900 hover:bg-emerald-100"
                        >
                          {source.title}
                          <span className="ml-2 text-xs text-slate-500">
                            {source.publisher}
                          </span>
                        </a>
                      ))}
                  </div>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </div>
      <ScoreCard score={score} />
    </section>
  );
}

export function ScoreCard({ score }: { score: TraceraScore }) {
  const rows = [
    ["Factual accuracy", score.factualAccuracy],
    ["Source corroboration", score.sourceCorroboration],
    ["Framing & language", score.framingManipulation],
    ["Evidence quality", score.evidenceQuality],
    ["Source reputation", score.sourceReputation ?? score.sourceCorroboration],
  ] as const;

  return (
    <aside className="noise order-1 h-fit overflow-hidden rounded-3xl bg-emerald-950 p-6 text-white shadow-[0_20px_55px_-22px_rgba(6,78,59,.7)] lg:sticky lg:top-6 lg:order-2">
      <p className="relative z-10 text-[10px] font-black tracking-[0.2em] text-[#9cf0d1]">
        TRACERA SCORE
      </p>
      <p className="relative z-10 mt-3 text-6xl font-black tracking-[-.08em] text-white">
        {score.overall}
        <span className="text-xl">/100</span>
      </p>
      <div className="relative z-10 mt-6 divide-y divide-white/12 border-y border-white/12">
        {rows.map(([name, dimension]) => (
          <div
            key={name}
            className="flex items-center justify-between py-2 text-sm"
          >
            <span className="text-white/65">{name}</span>
            <span className="font-bold text-white">
              {dimension.score} · {dimension.label}
            </span>
          </div>
        ))}
      </div>
      <p className="relative z-10 mt-5 rounded-2xl border border-white/10 bg-white/8 p-3.5 text-sm text-white/75">
        Evidence recency:{" "}
        <span className="font-semibold capitalize text-white">
          {score.recency.flag}
        </span>
      </p>
    </aside>
  );
}

function Verdict({ verdict }: { verdict: string }) {
  const styles: Record<string, string> = {
    supported: "bg-emerald-100 text-emerald-800",
    contradicted: "bg-rose-100 text-rose-800",
    misleading: "bg-amber-100 text-amber-800",
    mixed: "bg-violet-100 text-violet-800",
    unverified: "bg-slate-100 text-slate-700",
  };
  return (
    <span
      className={`rounded-full px-3 py-1.5 text-[11px] font-black uppercase tracking-[.08em] ${styles[verdict] ?? styles.unverified}`}
    >
      {verdict}
    </span>
  );
}
