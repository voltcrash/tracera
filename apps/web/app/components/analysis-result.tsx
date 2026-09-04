"use client";

import { useMemo, useState } from "react";
import type {
  ClaimResult,
  EvidenceSource,
  FramingAnalysis,
  TraceraScore,
  Verdict as VerdictName,
} from "@repo/contracts";
import { ChevronDown, ExternalLink, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export type { ClaimResult, TraceraScore } from "@repo/contracts";

const dimensionColors = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

const verdicts = {
  supported: { label: "Supported", badge: "emerald", dot: "bg-emerald-500", bar: "bg-emerald-500" },
  mixed: { label: "Mixed", badge: "violet", dot: "bg-violet-500", bar: "bg-violet-500" },
  misleading: { label: "Misleading", badge: "amber", dot: "bg-amber-500", bar: "bg-amber-500" },
  contradicted: { label: "Contradicted", badge: "rose", dot: "bg-rose-500", bar: "bg-rose-500" },
  unverified: { label: "Unverified", badge: "slate", dot: "bg-slate-400", bar: "bg-slate-400" },
} as const satisfies Record<
  VerdictName,
  {
    label: string;
    badge: "emerald" | "violet" | "amber" | "rose" | "slate";
    dot: string;
    bar: string;
  }
>;

const verdictOrder = Object.keys(verdicts) as VerdictName[];

function verdictStyle(verdict: string) {
  return verdicts[verdict as VerdictName] ?? verdicts.unverified;
}

export function AnalysisResult({
  claims,
  score,
  framing,
  showScore = true,
}: {
  claims: ClaimResult[];
  score: TraceraScore;
  framing?: FramingAnalysis | null;
  showScore?: boolean;
}) {
  const [filter, setFilter] = useState<VerdictName | null>(null);
  const counts = useMemo(() => tallyVerdicts(claims), [claims]);
  const visible = filter ? claims.filter((item) => item.verdict === filter) : claims;

  return (
    <section
      className={cn(
        "mt-8 grid gap-5",
        showScore && "lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-start",
      )}
    >
      <div className={showScore ? "order-2 lg:order-1" : ""}>
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 className="text-3xl font-extrabold tracking-[-.04em]">
            {claims.length === 1 ? "One claim to check" : `${claims.length} claims to check`}
          </h2>
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
            Each claim carries its own verdict and evidence. Read them independently.
          </p>
        </div>

        <VerdictSummary
          counts={counts}
          total={claims.length}
          filter={filter}
          onFilter={(verdict) => setFilter((current) => (current === verdict ? null : verdict))}
        />

        <div className="mt-5 space-y-4">
          {visible.map((item, index) => (
            <ClaimCard key={item.claim.id || index} item={item} />
          ))}
        </div>

        {framing && <FramingPanel framing={framing} />}
      </div>
      {showScore && <ScoreCard score={score} />}
    </section>
  );
}

function VerdictSummary({
  counts,
  total,
  filter,
  onFilter,
}: {
  counts: Array<[VerdictName, number]>;
  total: number;
  filter: VerdictName | null;
  onFilter: (verdict: VerdictName) => void;
}) {
  if (total < 2) return null;
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div
        className="flex h-2 gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={counts.map(([name, count]) => `${count} ${verdicts[name].label}`).join(", ")}
      >
        {counts.map(([name, count]) => (
          <span
            key={name}
            className={cn(
              verdicts[name].bar,
              "transition-opacity",
              filter && filter !== name && "opacity-25",
            )}
            style={{ width: `${(count / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {counts.map(([name, count]) => (
          <button
            key={name}
            type="button"
            onClick={() => onFilter(name)}
            aria-pressed={filter === name}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-1 text-xs font-semibold transition-opacity hover:opacity-100",
              filter && filter !== name ? "opacity-40" : "opacity-100",
            )}
          >
            <span className={cn("size-1.5 rounded-full", verdicts[name].dot)} />
            {count} {verdicts[name].label.toLowerCase()}
          </button>
        ))}
        {filter && (
          <button
            type="button"
            onClick={() => onFilter(filter)}
            className="ml-auto text-xs font-semibold text-brand-emerald hover:underline"
          >
            Show all claims
          </button>
        )}
      </div>
    </div>
  );
}

function ClaimCard({ item }: { item: ClaimResult }) {
  const [expanded, setExpanded] = useState(false);
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
    { label: "Supporting", sources: supporting, tone: "support" as const },
    { label: "Conflicting", sources: conflicting, tone: "conflict" as const },
    {
      label:
        item.supportingSources?.length || item.contradictingSources?.length
          ? "Also reviewed"
          : "Sources reviewed",
      sources: considered,
      tone: "review" as const,
    },
  ]
    .map((group) => ({ ...group, sources: rankSources(group.sources) }))
    .filter((group) => group.sources.length > 0);
  const totalSources = groups.reduce((count, group) => count + group.sources.length, 0);
  const hidden =
    totalSources - groups.reduce((count, group) => count + Math.min(group.sources.length, 3), 0);
  const context = item.claim.context?.trim();

  return (
    <Card asChild>
      <article className="landing-view-reveal gap-0 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <h3 className="max-w-2xl text-lg font-bold leading-snug tracking-[-.015em] sm:text-xl">
            {item.claim.claimText}
          </h3>
          <Verdict verdict={item.verdict} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-sm capitalize text-muted-foreground">
            {item.claim.claimType.replaceAll("_", " ")}
          </p>
          {item.sourceConflict && (
            <Badge variant="amber">
              <TriangleAlert />
              Sources disagree
            </Badge>
          )}
        </div>

        {context && context !== item.claim.claimText && (
          <p className="mt-3 max-w-[68ch] border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">
            {context}
          </p>
        )}

        <div className="mt-6 grid gap-x-6 gap-y-4 border-y border-border py-4 sm:grid-cols-3 sm:divide-x sm:divide-border">
          <Metric
            label="Confidence"
            value={`${confidence}%`}
            progress={confidence}
            indicator="bg-emerald-600"
          />
          <Metric
            label="Evidence quality"
            value={evidenceQuality === null ? "Not rated" : `${evidenceQuality}%`}
            progress={evidenceQuality}
            indicator="bg-violet-500"
            className="sm:pl-6"
          />
          <div className="sm:pl-6">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-muted-foreground">Checkability</span>
              <span className="truncate text-sm font-semibold capitalize">
                {item.claim.checkability.replaceAll("_", " ")}
              </span>
            </div>
            <Segments
              filled={checkabilityLevel(item.claim.checkability)}
              total={3}
              indicator="bg-amber-400"
            />
          </div>
        </div>

        {item.reasoning.length > 0 && (
          <div className="mt-5">
            <p className="text-sm font-semibold">Why this verdict</p>
            <ul className="mt-2.5 max-w-[68ch] space-y-2 text-sm leading-relaxed text-muted-foreground">
              {item.reasoning.map((reason, reasonIndex) => (
                <li key={reasonIndex} className="flex gap-2.5">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-emerald-600" />
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {groups.length > 0 && (
          <div className="mt-6">
            <Separator className="mb-5" />
            <p className="text-sm font-semibold">
              Evidence reviewed
              <span className="ml-2 font-normal text-muted-foreground">
                {totalSources} {totalSources === 1 ? "source" : "sources"}
              </span>
            </p>
            <div className="mt-4 grid gap-x-6 gap-y-6 md:grid-cols-3">
              {groups.map((group) => (
                <SourceGroup key={group.label} {...group} expanded={expanded} />
              ))}
            </div>
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((open) => !open)}
                className="mt-4 flex items-center gap-1.5 text-sm font-semibold text-brand-emerald hover:underline"
              >
                {expanded
                  ? "Show fewer sources"
                  : `Show ${hidden} more source${hidden === 1 ? "" : "s"}`}
                <ChevronDown
                  className={cn("size-4 transition-transform", expanded && "rotate-180")}
                />
              </button>
            )}
          </div>
        )}
      </article>
    </Card>
  );
}

function Metric({
  label,
  value,
  progress,
  indicator,
  className,
}: {
  label: string;
  value: string;
  progress?: number | null;
  indicator: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="truncate text-sm font-semibold capitalize">{value}</span>
      </div>
      <Progress
        className={cn("mt-2", progress === null && "opacity-40")}
        value={progress ?? 100}
        indicatorClassName={progress === null ? "bg-muted-foreground" : indicator}
      />
    </div>
  );
}

/** A discrete scale, so an unrated or ordinal value never reads as a full bar. */
function Segments({
  filled,
  total,
  indicator,
}: {
  filled: number;
  total: number;
  indicator: string;
}) {
  return (
    <div className="mt-2 flex gap-1">
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className={cn("h-1 flex-1 rounded-full", index < filled ? indicator : "bg-primary/8")}
        />
      ))}
    </div>
  );
}

function SourceGroup({
  label,
  sources,
  tone,
  expanded,
}: {
  label: string;
  sources: EvidenceSource[];
  tone: "support" | "conflict" | "review";
  expanded: boolean;
}) {
  const rules = {
    support: "border-emerald-600",
    conflict: "border-rose-500",
    review: "border-amber-500",
  };
  const shown = expanded ? sources : sources.slice(0, 3);
  return (
    <div className={cn("border-t-2 pt-3", rules[tone])}>
      <p className="flex items-baseline justify-between gap-2 text-sm font-semibold">
        {label}
        <span className="font-normal text-muted-foreground">{sources.length}</span>
      </p>
      <ul className="mt-2 divide-y divide-border">
        {shown.map((source) => (
          <SourceLink key={source.id} source={source} detailed={expanded} />
        ))}
      </ul>
    </div>
  );
}

function SourceLink({ source, detailed }: { source: EvidenceSource; detailed: boolean }) {
  const credibility =
    typeof source.credibility === "number" ? Math.round(source.credibility * 100) : null;
  const content = (
    <>
      <span className="flex items-start gap-1.5 text-sm leading-snug">
        <span className="line-clamp-2">{source.title}</span>
        {source.url && <ExternalLink className="mt-1 size-3 shrink-0 opacity-50" />}
      </span>
      {(source.publisher || source.publishedAt) && (
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {source.publisher ?? "Source"}
          {source.publishedAt
            ? `, ${new Date(source.publishedAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })}`
            : ""}
        </span>
      )}
    </>
  );
  return (
    <li className="py-2">
      {source.url ? (
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="block transition hover:text-brand-emerald"
        >
          {content}
        </a>
      ) : (
        content
      )}
      {(source.rating || credibility !== null) && (
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {source.rating && (
            <Badge variant="outline" className="capitalize">
              {source.rating}
            </Badge>
          )}
          {credibility !== null && (
            <span className="text-xs text-muted-foreground">{credibility}% credibility</span>
          )}
        </span>
      )}
      {detailed && source.snippet && (
        <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
          {source.snippet}
        </p>
      )}
    </li>
  );
}

function FramingPanel({ framing }: { framing: FramingAnalysis }) {
  const integrity = Math.round(framing.integrityScore * 100);
  const risks = [
    { label: "Emotional language", level: framing.emotionalLanguageLevel },
    { label: "Factual skew", level: framing.factualSkewLevel },
    { label: "Context omission", level: framing.contextOmissionRisk },
  ];

  return (
    <Card asChild>
      <section className="mt-4 gap-0 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div>
            <h3 className="text-lg font-bold tracking-[-.015em] sm:text-xl">How it is told</h3>
            <p className="mt-1 max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
              Presentation is scored separately from truth. A true story can still be framed to push
              a reading.
            </p>
          </div>
          <Badge variant={integrity >= 70 ? "emerald" : integrity >= 45 ? "amber" : "rose"}>
            {integrity}% presentation integrity
          </Badge>
        </div>

        <div className="mt-6 grid gap-x-6 gap-y-4 border-y border-border py-4 sm:grid-cols-3 sm:divide-x sm:divide-border">
          {risks.map((risk, index) => {
            const level = Math.round(risk.level * 100);
            return (
              <div key={risk.label} className={index > 0 ? "sm:pl-6" : undefined}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-muted-foreground">{risk.label}</span>
                  <span className="text-sm font-semibold">{riskWord(risk.level)}</span>
                </div>
                <Progress
                  className="mt-2"
                  value={level}
                  indicatorClassName={
                    risk.level >= 0.6
                      ? "bg-rose-500"
                      : risk.level >= 0.3
                        ? "bg-amber-400"
                        : "bg-emerald-600"
                  }
                />
              </div>
            );
          })}
        </div>

        {framing.findings.length > 0 && (
          <ul className="mt-5 max-w-[68ch] space-y-2 text-sm leading-relaxed text-muted-foreground">
            {framing.findings.map((finding, index) => (
              <li key={index} className="flex gap-2.5">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-amber-500" />
                <span>{finding}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Card>
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
  const reading =
    score.overall >= 70
      ? "Strong signal"
      : score.overall >= 45
        ? "Needs context"
        : "Low confidence";
  const newestEvidence = score.recency.newestEvidenceAt;

  return (
    <aside
      className={cn(
        "app-score-card noise order-1 h-fit overflow-hidden rounded-3xl bg-panel px-6 py-7 text-panel-foreground shadow-(--shadow-panel) lg:order-2",
        sticky && "lg:sticky lg:top-24",
      )}
    >
      <div className="relative z-10">
        <h2 className="text-sm font-semibold text-white/70">Tracera Score</h2>
        <p className="mt-3 flex items-baseline gap-2">
          <span
            className={cn(
              "text-[5.5rem] font-black leading-[.8] tracking-[-.06em]",
              score.overall >= 70
                ? "text-brand-mint"
                : score.overall >= 45
                  ? "text-amber-300"
                  : "text-rose-300",
            )}
            aria-label={`Overall score ${score.overall} out of 100`}
          >
            {score.overall}
          </span>
          <span className="text-lg font-semibold text-white/35">/100</span>
        </p>
        <p className="mt-3 text-base font-semibold">{reading}</p>
      </div>

      <div className="relative z-10 mt-7 space-y-3">
        {rows.map(([name, dimension], index) => (
          <div key={name}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate text-white/60">{name}</span>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="capitalize text-white/40">{dimension.label}</span>
                <span className="font-semibold tabular-nums">{dimension.score}</span>
              </span>
            </div>
            <Progress
              className="h-1.5 bg-white/10"
              indicatorClassName={dimensionColors[index]}
              value={Math.max(0, Math.min(100, dimension.score))}
            />
          </div>
        ))}
      </div>

      <Separator className="relative z-10 mt-7 bg-white/10" />
      <p className="relative z-10 pt-4 text-xs text-white/50">
        Evidence recency: <span className="capitalize text-white/80">{score.recency.flag}</span>
        {newestEvidence && (
          <>
            {" · newest "}
            <span className="text-white/80">
              {new Date(newestEvidence).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </>
        )}
      </p>
    </aside>
  );
}

function Verdict({ verdict }: { verdict: string }) {
  const style = verdictStyle(verdict);
  return (
    <Badge variant={style.badge} className="px-3 py-1.5">
      <span className={cn("size-1.5 rounded-full", style.dot)} />
      {style.label}
    </Badge>
  );
}

function tallyVerdicts(claims: ClaimResult[]) {
  return verdictOrder
    .map((verdict) => [verdict, claims.filter((item) => item.verdict === verdict).length] as const)
    .filter(([, count]) => count > 0)
    .map(([verdict, count]) => [verdict, count] as [VerdictName, number]);
}

function checkabilityLevel(checkability: string) {
  return checkability === "checkable" ? 3 : checkability === "needs_context" ? 2 : 1;
}

function riskWord(level: number) {
  return level >= 0.6 ? "High" : level >= 0.3 ? "Moderate" : "Low";
}

function uniqueSources(sources: EvidenceSource[]) {
  return sources.filter(
    (source, index) => sources.findIndex((candidate) => candidate.id === source.id) === index,
  );
}

/** Surface the strongest evidence first, since only the top few stay visible. */
function rankSources(sources: EvidenceSource[]) {
  return uniqueSources(sources)
    .slice()
    .sort((first, second) => (second.credibility ?? 0) - (first.credibility ?? 0));
}
