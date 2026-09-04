"use client";

import type { ClaimResult, EvidenceSource, TraceraScore } from "@repo/contracts";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export type { ClaimResult, TraceraScore } from "@repo/contracts";

const dimensionColors = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

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
      className={cn(
        "mt-8 grid gap-5",
        showScore && "lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-start",
      )}
    >
      <div className={showScore ? "order-2 lg:order-1" : ""}>
        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h2 className="text-3xl font-extrabold tracking-[-.04em]">
            {claims.length === 1 ? "One claim to check" : `${claims.length} claims to check`}
          </h2>
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
            Each claim carries its own verdict and evidence. Read them independently.
          </p>
        </div>
        <div className="space-y-4">
          {claims.map((item, index) => (
            <ClaimCard key={item.claim.id || index} item={item} />
          ))}
        </div>
      </div>
      {showScore && <ScoreCard score={score} />}
    </section>
  );
}

function ClaimCard({ item }: { item: ClaimResult }) {
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
    .map((group) => ({ ...group, sources: uniqueSources(group.sources).slice(0, 4) }))
    .filter((group) => group.sources.length > 0);

  return (
    <Card asChild>
      <article className="landing-view-reveal gap-0 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <h3 className="max-w-2xl text-lg font-bold leading-snug tracking-[-.015em] sm:text-xl">
            {item.claim.claimText}
          </h3>
          <Verdict verdict={item.verdict} />
        </div>
        <p className="mt-2 text-sm capitalize text-muted-foreground">
          {item.claim.claimType.replaceAll("_", " ")}
        </p>

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
          <Metric
            label="Checkability"
            value={item.claim.checkability.replaceAll("_", " ")}
            indicator="bg-amber-400"
            className="sm:pl-6"
          />
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
                {uniqueSources(groups.flatMap((group) => group.sources)).length} sources
              </span>
            </p>
            <div className="mt-4 grid gap-x-6 gap-y-6 md:grid-cols-3">
              {groups.map((group) => (
                <SourceGroup key={group.label} {...group} />
              ))}
            </div>
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
      <Progress className="mt-2" value={progress ?? 100} indicatorClassName={indicator} />
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
  const rules = {
    support: "border-emerald-600",
    conflict: "border-rose-500",
    review: "border-amber-500",
  };
  return (
    <div className={cn("border-t-2 pt-3", rules[tone])}>
      <p className="flex items-baseline justify-between gap-2 text-sm font-semibold">
        {label}
        <span className="font-normal text-muted-foreground">{sources.length}</span>
      </p>
      <ul className="mt-2 divide-y divide-border">
        {sources.map((source) => (
          <SourceLink key={source.id} source={source} />
        ))}
      </ul>
    </div>
  );
}

function SourceLink({ source }: { source: EvidenceSource }) {
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
    </li>
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

  return (
    <aside
      className={cn(
        "app-score-card noise order-1 h-fit overflow-hidden rounded-3xl bg-brand-deep px-6 py-7 text-white shadow-[0_28px_70px_-32px_rgba(6,78,59,.78)] lg:order-2",
        sticky && "lg:sticky lg:top-24",
      )}
    >
      <div className="relative z-10">
        <h2 className="text-sm font-semibold text-white/70">Tracera Score</h2>
        <p className="mt-3 flex items-baseline gap-2">
          <span
            className="text-[5.5rem] font-black leading-[.8] tracking-[-.06em] text-brand-mint"
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
              <span className="font-semibold tabular-nums">{dimension.score}</span>
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
      </p>
    </aside>
  );
}

function Verdict({ verdict }: { verdict: string }) {
  const variants: Record<string, "emerald" | "rose" | "amber" | "violet" | "slate"> = {
    supported: "emerald",
    contradicted: "rose",
    misleading: "amber",
    mixed: "violet",
    unverified: "slate",
  };
  const dots: Record<string, string> = {
    supported: "bg-emerald-500",
    contradicted: "bg-rose-500",
    misleading: "bg-amber-500",
    mixed: "bg-violet-500",
    unverified: "bg-slate-500",
  };
  return (
    <Badge variant={variants[verdict] ?? "slate"} className="px-3 py-1.5">
      <span className={cn("size-1.5 rounded-full", dots[verdict] ?? dots.unverified)} />
      <span className="capitalize">{verdict}</span>
    </Badge>
  );
}

function uniqueSources(sources: EvidenceSource[]) {
  return sources.filter(
    (source, index) => sources.findIndex((candidate) => candidate.id === source.id) === index,
  );
}
