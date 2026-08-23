"use client";

import type { ClaimResult, EvidenceSource, TraceraScore } from "@repo/contracts";

export type { ClaimResult, TraceraScore } from "@repo/contracts";

const dimensionColors = [
  "bg-[#9cf0d1]",
  "bg-[#72dfbd]",
  "bg-[#d8b4fe]",
  "bg-[#f5d67b]",
  "bg-[#9fdde8]",
];

export function AnalysisResult({
  claims,
  score,
  showScore = true,
}: {
  claims: ClaimResult[];
  score: TraceraScore;
  showScore?: boolean;
}) {
  return (
    <section
      className={`mt-8 grid gap-5 ${showScore ? "lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-start" : ""}`}
    >
      <div className={showScore ? "order-2 lg:order-1" : ""}>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-black tracking-[.2em] text-emerald-700">
              CLAIM DECOMPOSITION · {String(claims.length).padStart(2, "0")}
            </p>
            <h2 className="mt-2 text-3xl font-black leading-none tracking-[-.055em] text-emerald-950">
              Story, separated from spin.
            </h2>
          </div>
          <p className="max-w-52 text-right text-xs font-semibold leading-5 text-emerald-950/45">
            Read every claim and its evidence independently.
          </p>
        </div>
        <div className="space-y-4">
          {claims.map((item, index) => (
            <ClaimCard key={item.claim.id || index} item={item} index={index} />
          ))}
        </div>
      </div>
      {showScore && <ScoreCard score={score} />}
    </section>
  );
}

function ClaimCard({ item, index }: { item: ClaimResult; index: number }) {
  const confidence = Math.round(item.confidence * 100);
  const evidenceQuality =
    typeof item.evidenceQuality === "number" ? Math.round(item.evidenceQuality * 100) : null;
  const supporting = uniqueSources(item.supportingSources ?? []);
  const conflicting = uniqueSources(item.contradictingSources ?? []);
  const classifiedIds = new Set([...supporting, ...conflicting].map((source) => source.id));
  const considered = uniqueSources(item.consideredSources ?? []).filter(
    (source) => !classifiedIds.has(source.id),
  );
  const groups = [
    {
      label: "Supporting",
      sources: supporting,
      tone: "support" as const,
    },
    {
      label: "Conflicting",
      sources: conflicting,
      tone: "conflict" as const,
    },
    {
      label:
        item.supportingSources?.length || item.contradictingSources?.length
          ? "Also reviewed"
          : "Sources reviewed",
      sources: considered,
      tone: "review" as const,
    },
  ]
    .map((group) => ({
      ...group,
      sources: uniqueSources(group.sources).slice(0, 4),
    }))
    .filter((group) => group.sources.length > 0);

  return (
    <article className="analysis-claim-card landing-view-reveal">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex max-w-2xl gap-3.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-emerald-950 text-[10px] font-black text-[#9cf0d1]">
            {String(index + 1).padStart(2, "0")}
          </span>
          <div>
            <p className="text-[9px] font-black uppercase tracking-[.16em] text-emerald-700">
              {item.claim.claimType.replaceAll("_", " ")}
            </p>
            <h3 className="mt-1.5 text-base font-black leading-6 tracking-[-.02em] text-emerald-950 sm:text-lg">
              {item.claim.claimText}
            </h3>
          </div>
        </div>
        <Verdict verdict={item.verdict} />
      </div>

      <div className="mt-6 grid gap-2 sm:grid-cols-3">
        <Metric
          label="Confidence"
          value={`${confidence}%`}
          progress={confidence}
          color="bg-emerald-500"
        />
        <Metric
          label="Evidence quality"
          value={evidenceQuality === null ? "Not rated" : `${evidenceQuality}%`}
          progress={evidenceQuality}
          color="bg-violet-500"
        />
        <Metric
          label="Checkability"
          value={item.claim.checkability.replaceAll("_", " ")}
          color="bg-amber-400"
        />
      </div>

      {item.reasoning.length > 0 && (
        <div className="mt-5 rounded-2xl bg-[#f3f7f3] p-4 sm:p-5">
          <p className="text-[9px] font-black uppercase tracking-[.16em] text-emerald-700">
            Why this verdict
          </p>
          <ul className="mt-3 space-y-2.5 text-sm leading-6 text-emerald-950/68">
            {item.reasoning.map((reason, reasonIndex) => (
              <li key={reasonIndex} className="flex gap-2.5">
                <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {groups.length > 0 && (
        <div className="mt-5 border-t border-emerald-950/8 pt-5">
          <div className="flex items-center justify-between gap-4">
            <p className="text-[9px] font-black uppercase tracking-[.16em] text-emerald-950/45">
              Evidence sources
            </p>
            <p className="text-[9px] font-bold text-emerald-950/38">
              {uniqueSources(groups.flatMap((group) => group.sources)).length} reviewed
            </p>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {groups.map((group) => (
              <SourceGroup key={group.label} {...group} />
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

function Metric({
  label,
  value,
  progress,
  color,
}: {
  label: string;
  value: string;
  progress?: number | null;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-emerald-950/8 bg-white/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-black uppercase tracking-[.1em] text-emerald-950/38">
          {label}
        </span>
        <strong className="truncate text-[11px] capitalize text-emerald-950/75">{value}</strong>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-emerald-950/6">
        <span
          className={`block h-full rounded-full ${color}`}
          style={{ width: `${progress ?? 100}%` }}
        />
      </div>
    </div>
  );
}

function SourceGroup({
  label,
  sources,
  tone,
}: {
  label: string;
  sources: EvidenceSource[];
  tone: "support" | "conflict" | "review";
}) {
  const tones = {
    support: "border-emerald-200 bg-emerald-50 text-emerald-800",
    conflict: "border-rose-200 bg-rose-50 text-rose-800",
    review: "border-amber-200 bg-amber-50 text-amber-800",
  };
  const dots = {
    support: "bg-emerald-500",
    conflict: "bg-rose-500",
    review: "bg-amber-500",
  };
  return (
    <div className={`rounded-2xl border p-3 ${tones[tone]}`}>
      <p className="flex items-center justify-between text-[9px] font-black uppercase tracking-[.12em]">
        <span className="flex items-center gap-2">
          <span className={`size-1.5 rounded-full ${dots[tone]}`} /> {label}
        </span>
        <span>{String(sources.length).padStart(2, "0")}</span>
      </p>
      <div className="mt-3 space-y-2">
        {sources.map((source) => (
          <SourceLink key={source.id} source={source} />
        ))}
      </div>
    </div>
  );
}

function SourceLink({ source }: { source: EvidenceSource }) {
  const content = (
    <>
      <strong className="block line-clamp-2 text-[10px] leading-4">{source.title}</strong>
      {(source.publisher || source.publishedAt) && (
        <small className="mt-1 block truncate text-[9px] font-semibold opacity-55">
          {source.publisher ?? "Source"}
          {source.publishedAt ? ` · ${new Date(source.publishedAt).toLocaleDateString()}` : ""}
        </small>
      )}
    </>
  );
  const className = "block rounded-xl bg-white/70 px-3 py-2.5 transition hover:bg-white";
  return source.url ? (
    <a href={source.url} target="_blank" rel="noreferrer" className={className}>
      {content}
    </a>
  ) : (
    <div className={className}>{content}</div>
  );
}

export function ScoreCard({ score, sticky = true }: { score: TraceraScore; sticky?: boolean }) {
  const rows = [
    ["Factual accuracy", score.factualAccuracy],
    ["Source corroboration", score.sourceCorroboration],
    ["Framing & language", score.framingManipulation],
    ["Evidence quality", score.evidenceQuality],
    ["Source reputation", score.sourceReputation ?? score.sourceCorroboration],
  ] as const;
  const overall = Math.max(0, Math.min(100, score.overall));

  return (
    <aside
      className={`app-score-card noise order-1 h-fit overflow-hidden rounded-[2rem] bg-[#0e3028] p-6 text-white shadow-[0_28px_70px_-32px_rgba(6,78,59,.78)] lg:order-2 ${sticky ? "lg:sticky lg:top-24" : ""}`}
    >
      <div className="relative z-10 flex items-start justify-between gap-3">
        <div>
          <p className="text-[9px] font-black tracking-[.18em] text-[#9cf0d1]">
            TRANSPARENT BY DESIGN
          </p>
          <h2 className="mt-2 text-xl font-black tracking-[-.04em]">Tracera Score</h2>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/8 px-2.5 py-1 text-[9px] font-black text-white/60">
          <span className="size-1.5 rounded-full bg-[#9cf0d1]" /> LIVE SIGNALS
        </span>
      </div>

      <div className="relative z-10 mt-7 grid grid-cols-[auto_1fr] items-center gap-6">
        <div
          className="app-score-ring"
          style={{
            background: `conic-gradient(#9cf0d1 0 ${overall}%, rgba(255,255,255,.09) ${overall}% 100%)`,
          }}
          aria-label={`Overall score ${score.overall} out of 100`}
        >
          <div>
            <strong>{score.overall}</strong>
            <span>/100</span>
          </div>
        </div>
        <div className="space-y-3.5">
          {rows.map(([name, dimension], index) => (
            <div key={name}>
              <div className="mb-1.5 flex items-center justify-between gap-3 text-[9px] font-bold">
                <span className="truncate text-white/55">{name}</span>
                <span className="text-white">{dimension.score}</span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-white/10">
                <span
                  className={`block h-full rounded-full ${dimensionColors[index]}`}
                  style={{
                    width: `${Math.max(0, Math.min(100, dimension.score))}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="relative z-10 mt-7 flex items-center justify-between gap-4 border-t border-white/10 pt-5">
        <div>
          <p className="text-[9px] font-black tracking-[.13em] text-white/38">EVIDENCE RECENCY</p>
          <p className="mt-1 text-xs font-bold capitalize text-white/75">{score.recency.flag}</p>
        </div>
        <span className="rounded-full bg-[#9cf0d1]/12 px-3 py-1.5 text-[9px] font-black uppercase tracking-[.1em] text-[#9cf0d1]">
          {score.overall >= 70
            ? "Strong signal"
            : score.overall >= 45
              ? "Needs context"
              : "Low confidence"}
        </span>
      </div>
    </aside>
  );
}

function Verdict({ verdict }: { verdict: string }) {
  const styles: Record<string, string> = {
    supported: "border-emerald-200 bg-emerald-100 text-emerald-800",
    contradicted: "border-rose-200 bg-rose-100 text-rose-800",
    misleading: "border-amber-200 bg-amber-100 text-amber-800",
    mixed: "border-violet-200 bg-violet-100 text-violet-800",
    unverified: "border-slate-200 bg-slate-100 text-slate-700",
  };
  const dots: Record<string, string> = {
    supported: "bg-emerald-500",
    contradicted: "bg-rose-500",
    misleading: "bg-amber-500",
    mixed: "bg-violet-500",
    unverified: "bg-slate-500",
  };
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[9px] font-black uppercase tracking-[.1em] ${styles[verdict] ?? styles.unverified}`}
    >
      <span className={`size-1.5 rounded-full ${dots[verdict] ?? dots.unverified}`} />
      {verdict}
    </span>
  );
}

function uniqueSources(sources: EvidenceSource[]) {
  return sources.filter(
    (source, index) => sources.findIndex((candidate) => candidate.id === source.id) === index,
  );
}
