"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { TraceraScore } from "@repo/contracts";
import {
  Archive,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Grid2x2,
  Rows3,
  Search,
  SlidersHorizontal,
  Waves,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** A listed check, as returned by both the News Hub and personal history. */
export type TraceSummary = {
  id: string;
  rawInput: string;
  traceraScore: TraceraScore;
  createdAt: string;
  sourceDomain: string | null;
  publishedAt: string | null;
  visibility: "public" | "private";
  appearanceCount: number;
};

export type TraceViewMode = "grid" | "list";

export type TraceOption<Value extends string = string> = {
  value: Value;
  label: string;
};

function scoreTone(score: number) {
  return score >= 70 ? "strong" : score >= 45 ? "mixed" : "weak";
}

const labelVariants = {
  strong: "emerald",
  mixed: "amber",
  weak: "rose",
} as const;

const toneLabels = {
  strong: "Strong signal",
  mixed: "Needs context",
  weak: "Low confidence",
} as const;

/**
 * One trace in the library. `timestamp` lets a screen show the date that
 * matters to it — when the trace was created, or when this user last ran it.
 */
export function TraceCard({
  trace,
  viewMode,
  timestamp,
  pills,
  actions,
}: {
  trace: TraceSummary;
  viewMode: TraceViewMode;
  timestamp?: string;
  pills?: ReactNode;
  actions?: ReactNode;
}) {
  const score = Math.max(0, Math.min(100, trace.traceraScore.overall));
  const tone = scoreTone(score);
  const shownAt = timestamp ?? trace.createdAt;
  const label = <Badge variant={labelVariants[tone]}>{toneLabels[tone]}</Badge>;
  const source = (
    <p
      className="truncate text-xs font-bold text-muted-foreground"
      title={trace.sourceDomain ?? "Direct submission"}
    >
      {trace.sourceDomain ?? "Direct submission"}
    </p>
  );
  const ring = (
    <div
      className="hub-score-ring"
      data-tone={tone}
      style={{ "--score": `${score}%` } as React.CSSProperties}
      aria-label={`Signal score ${trace.traceraScore.overall} out of 100`}
    >
      <span>{trace.traceraScore.overall}</span>
    </div>
  );

  if (viewMode === "list") {
    return (
      <Card render={<article className="hub-list-row group gap-0 py-0" />}>
        <div className="hub-list-meta min-w-0">
          {label}
          <div className="mt-2">{source}</div>
        </div>

        <Link
          href={`/hub/${trace.id}`}
          className="hub-list-title line-clamp-2 min-w-0 font-black leading-[1.3] tracking-[-.025em] outline-offset-4 transition group-hover:text-brand-emerald focus-visible:outline-2 focus-visible:outline-ring"
        >
          {trace.rawInput}
        </Link>

        <div className="hub-list-state">
          <div className="flex flex-wrap gap-1.5">
            <TraceStatusPills trace={trace} />
            {pills}
          </div>
          <TraceDate value={shownAt} />
        </div>

        <div className="hub-list-actions">
          {ring}
          {actions}
          <OpenTraceButton id={trace.id} />
        </div>
      </Card>
    );
  }

  return (
    <Card
      render={
        <article className="hub-check-card group flex min-h-[16.75rem] min-w-0 flex-col gap-0 overflow-hidden p-5 transition sm:p-6" />
      }
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {label}
          <div className="mt-3">{source}</div>
        </div>
        {ring}
      </div>

      <Link
        href={`/hub/${trace.id}`}
        className="mt-5 line-clamp-3 min-w-0 text-lg font-black leading-[1.28] tracking-[-.035em] outline-offset-4 transition group-hover:text-brand-emerald focus-visible:outline-2 focus-visible:outline-ring sm:text-xl"
      >
        {trace.rawInput}
      </Link>

      <div className="mt-auto pt-7">
        <div className="flex flex-wrap gap-1.5">
          <TraceStatusPills trace={trace} />
          {pills}
        </div>
        <Separator className="my-4" />
        <div className="flex items-center gap-3">
          <TraceDate value={shownAt} className="mr-auto" />
          {actions}
          <OpenTraceButton id={trace.id} />
        </div>
      </div>
    </Card>
  );
}

function TraceStatusPills({ trace }: { trace: TraceSummary }) {
  return (
    <>
      {trace.visibility === "private" && <Badge variant="slate">Private</Badge>}
      {trace.appearanceCount > 1 && <Badge variant="violet">Seen {trace.appearanceCount}×</Badge>}
    </>
  );
}

export function TraceDate({ value, className = "" }: { value: string; className?: string }) {
  return (
    <time dateTime={value} className={cn("text-[11px] font-bold text-muted-foreground", className)}>
      {new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}
    </time>
  );
}

function OpenTraceButton({ id }: { id: string }) {
  return (
    <Button
      render={<Link href={`/hub/${id}`} />}
      size="icon-sm"
      className="rounded-full transition group-hover:translate-x-1"
      aria-label="Open trace"
    >
      <ArrowRight />
    </Button>
  );
}

/** The filter, sort, view, and search controls shared by the library screens. */
export function TraceToolbar({
  filters,
  filter,
  onFilterChange,
  filtersLabel,
  sortOptions,
  sortOrder,
  onSortChange,
  viewMode,
  onViewModeChange,
  query,
  onQueryChange,
  searchLabel,
  searchPlaceholder,
  filtersOpen,
  onToggleFilters,
  hasSecondaryFilters,
  secondaryFilters,
}: {
  filters: TraceOption[];
  filter: string;
  onFilterChange: (value: string) => void;
  filtersLabel: string;
  sortOptions: TraceOption[];
  sortOrder: string;
  onSortChange: (value: string) => void;
  viewMode: TraceViewMode;
  onViewModeChange: (value: TraceViewMode) => void;
  query: string;
  onQueryChange: (value: string) => void;
  searchLabel: string;
  searchPlaceholder: string;
  filtersOpen: boolean;
  onToggleFilters: () => void;
  hasSecondaryFilters: boolean;
  secondaryFilters: ReactNode;
}) {
  return (
    <>
      <div className="mt-7 flex flex-wrap items-center gap-2.5 lg:mt-9">
        <ToggleGroup
          value={[filter]}
          onValueChange={(value) => value[0] && onFilterChange(value[0])}
          aria-label={filtersLabel}
          className="order-1 grid w-full grid-cols-2 sm:flex sm:w-auto"
        >
          {filters.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value}>
              {item.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <label className="order-3 flex min-w-56 flex-1 items-center gap-2 sm:order-2">
          <span className="sr-only">{searchLabel}</span>
          <span className="relative w-full">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={searchPlaceholder}
              type="search"
              className="rounded-full pl-10"
            />
          </span>
        </label>

        <div className="order-2 ml-auto flex items-center gap-2.5 sm:order-3 sm:ml-0">
          <Select
            items={sortOptions}
            value={sortOrder}
            onValueChange={(value) => value && onSortChange(value)}
          >
            <SelectTrigger aria-label="Sort traces">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sortOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <ToggleGroup
            value={[viewMode]}
            onValueChange={(value) => value[0] && onViewModeChange(value[0] as TraceViewMode)}
            aria-label="Choose trace library view"
          >
            {[
              { mode: "grid" as const, icon: Grid2x2, label: "Grid view" },
              { mode: "list" as const, icon: Rows3, label: "List view" },
            ].map((item) => (
              <Tooltip key={item.mode}>
                <TooltipTrigger
                  render={<ToggleGroupItem value={item.mode} aria-label={item.label} size="sm" />}
                >
                  <item.icon />
                </TooltipTrigger>
                <TooltipContent>{item.label}</TooltipContent>
              </Tooltip>
            ))}
          </ToggleGroup>

          <Button
            type="button"
            variant={filtersOpen || hasSecondaryFilters ? "default" : "outline"}
            className="rounded-full"
            onClick={onToggleFilters}
            aria-expanded={filtersOpen}
            aria-controls="trace-secondary-filters"
          >
            <SlidersHorizontal />
            Filters
            {hasSecondaryFilters && <span className="size-1.5 rounded-full bg-brand-mint" />}
          </Button>
        </div>
      </div>

      {filtersOpen && (
        <div
          id="trace-secondary-filters"
          className="mt-3 flex flex-wrap items-end gap-6 rounded-2xl border border-border bg-card/70 p-4"
        >
          {secondaryFilters}
        </div>
      )}
    </>
  );
}

export function TraceFilterGroup({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: TraceOption[];
}) {
  return (
    <div>
      <Label className="text-sm font-normal text-muted-foreground">{label}</Label>
      <ToggleGroup
        value={[value]}
        onValueChange={(next) => next[0] && onChange(next[0])}
        className="mt-2"
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value} size="sm">
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

const statIcons = {
  archive: Archive,
  signal: Waves,
  review: Search,
  violet: Grid2x2,
};

export function TraceStat({
  value,
  label,
  icon,
}: {
  value: string;
  label: string;
  icon: keyof typeof statIcons;
}) {
  const Icon = statIcons[icon];
  return (
    <div className="flex items-center gap-4 py-5 first:pt-0 last:pb-0">
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="ml-auto text-3xl font-black tabular-nums tracking-[-.05em] text-foreground">
        {value}
      </p>
    </div>
  );
}

export function TraceLoading({
  compact = false,
  viewMode = "grid",
}: {
  compact?: boolean;
  viewMode?: TraceViewMode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)] gap-4",
        compact ? "mt-5" : "mt-8",
        viewMode === "grid" && "md:grid-cols-2 xl:grid-cols-3",
      )}
      role="status"
    >
      {[0, 1, 2].map((item) => (
        <Skeleton
          key={item}
          className={cn("rounded-3xl", viewMode === "grid" ? "h-[16.75rem]" : "h-32")}
        />
      ))}
      <span className="sr-only">Loading traces…</span>
    </div>
  );
}

export function TraceResults({
  viewMode,
  children,
}: {
  viewMode: TraceViewMode;
  children: ReactNode;
}) {
  return (
    <div
      className={
        viewMode === "grid"
          ? "mt-5 grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 xl:grid-cols-3 xl:gap-5"
          : "mt-5 grid gap-3"
      }
    >
      {children}
    </div>
  );
}

export function TracePagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="mt-6 flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft />
          Previous
        </Button>
        <Button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          Next
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
