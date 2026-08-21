"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { TraceraScore } from "./analysis-result";

/** A listed check, as returned by both the News Hub and personal history. */
export type TraceSummary = {
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

export type TraceViewMode = "grid" | "list";

export type TraceOption<Value extends string = string> = {
  value: Value;
  label: string;
};

function scoreTone(score: number) {
  return score >= 70 ? "strong" : score >= 45 ? "mixed" : "weak";
}

/**
 * One trace in the library. `timestamp` lets a screen show the date that
 * matters to it — when the trace was created, or when this user last ran it.
 */
export function TraceCard({
  trace,
  traceNumber,
  viewMode,
  timestamp,
  pills,
  actions,
}: {
  trace: TraceSummary;
  traceNumber: number;
  viewMode: TraceViewMode;
  timestamp?: string;
  pills?: ReactNode;
  actions?: ReactNode;
}) {
  const score = Math.max(0, Math.min(100, trace.traceraScore.overall));
  const tone = scoreTone(score);
  const shownAt = timestamp ?? trace.createdAt;
  const label = (
    <span className={`hub-trace-label hub-trace-label-${tone}`}>
      TRACE {String(traceNumber).padStart(2, "0")}
    </span>
  );
  const source = (
    <p
      className="truncate text-xs font-bold text-emerald-950/48"
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
      <article className="hub-list-row group">
        <div className="hub-list-meta min-w-0">
          {label}
          <div className="mt-2">{source}</div>
        </div>

        <Link
          href={`/hub/${trace.id}`}
          className="hub-check-title hub-list-title min-w-0 line-clamp-2 font-black leading-[1.3] tracking-[-.025em] text-emerald-950 outline-offset-4 transition group-hover:text-emerald-700 focus-visible:outline-2 focus-visible:outline-emerald-600"
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
      </article>
    );
  }

  return (
    <article className="hub-check-card group flex min-h-[16.75rem] min-w-0 flex-col overflow-hidden rounded-[1.5rem] border border-emerald-950/10 bg-white p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {label}
          <div className="mt-3">{source}</div>
        </div>
        {ring}
      </div>

      <Link
        href={`/hub/${trace.id}`}
        className="hub-check-title mt-5 min-w-0 line-clamp-3 text-lg font-black leading-[1.28] tracking-[-.035em] text-emerald-950 outline-offset-4 transition group-hover:text-emerald-700 focus-visible:outline-2 focus-visible:outline-emerald-600 sm:text-xl"
      >
        {trace.rawInput}
      </Link>

      <div className="mt-auto pt-7">
        <div className="flex flex-wrap gap-1.5">
          <TraceStatusPills trace={trace} />
          {pills}
        </div>

        <div className="mt-4 flex items-center gap-3 border-t border-emerald-950/8 pt-4">
          <TraceDate value={shownAt} className="mr-auto" />
          {actions}
          <OpenTraceButton id={trace.id} />
        </div>
      </div>
    </article>
  );
}

function TraceStatusPills({ trace }: { trace: TraceSummary }) {
  return (
    <>
      <StatusPill
        tone={trace.reanalysisState === "review_due" ? "amber" : "emerald"}
        label={trace.reanalysisState === "review_due" ? "Review due" : "Monitoring"}
      />
      {trace.visibility === "private" && <StatusPill tone="slate" label="Private" />}
      {trace.appearanceCount > 1 && (
        <StatusPill tone="violet" label={`Seen ${trace.appearanceCount}×`} />
      )}
    </>
  );
}

export function TraceDate({ value, className = "" }: { value: string; className?: string }) {
  return (
    <time dateTime={value} className={`${className} text-[11px] font-bold text-emerald-950/46`}>
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
    <Link
      href={`/hub/${id}`}
      aria-label="Open trace"
      className="grid size-9 shrink-0 place-items-center rounded-full bg-[#074b3d] text-sm text-white shadow-[0_7px_18px_-10px_rgba(7,75,61,.9)] transition group-hover:translate-x-1 group-hover:bg-emerald-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
    >
      →
    </Link>
  );
}

export function StatusPill({
  tone,
  label,
}: {
  tone: "emerald" | "amber" | "slate" | "violet" | "ink";
  label: string;
}) {
  const tones = {
    emerald: "bg-emerald-100 text-emerald-800",
    amber: "bg-amber-100 text-amber-800",
    slate: "bg-slate-100 text-slate-700",
    violet: "bg-violet-100 text-violet-800",
    ink: "bg-emerald-950 text-[#9cf0d1]",
  };
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[8px] font-black uppercase tracking-[.08em] ${tones[tone]}`}
    >
      {label}
    </span>
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
      <div className="hub-toolbar mt-7 lg:mt-9">
        <div className="hub-filter-scroll" aria-label={filtersLabel}>
          {filters.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => onFilterChange(item.value)}
              aria-pressed={filter === item.value}
              className={`hub-filter-tab ${filter === item.value ? "hub-filter-tab-active" : ""}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <label className="hub-sort-control">
          <span>Sort by:</span>
          <select
            value={sortOrder}
            onChange={(event) => onSortChange(event.target.value)}
            aria-label="Sort traces"
          >
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <div className="hub-view-toggle" role="group" aria-label="Choose trace library view">
          {(["grid", "list"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onViewModeChange(mode)}
              aria-pressed={viewMode === mode}
              aria-label={`${mode === "grid" ? "Grid" : "List"} view`}
              title={`${mode === "grid" ? "Grid" : "List"} view`}
              className={`hub-view-button ${viewMode === mode ? "hub-view-button-active" : ""}`}
            >
              <span className={`hub-view-icon hub-view-icon-${mode}`} aria-hidden="true" />
            </button>
          ))}
        </div>

        <label className="hub-search-control">
          <span className="sr-only">{searchLabel}</span>
          <span className="hub-search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={searchPlaceholder}
            type="search"
          />
        </label>

        <button
          type="button"
          onClick={onToggleFilters}
          aria-expanded={filtersOpen}
          aria-controls="trace-secondary-filters"
          className={`hub-filters-button ${filtersOpen || hasSecondaryFilters ? "hub-filters-button-active" : ""}`}
        >
          Filters
          {hasSecondaryFilters && <span className="hub-filter-dot" />}
          <span aria-hidden="true">▽</span>
        </button>
      </div>

      {filtersOpen && (
        <div id="trace-secondary-filters" className="hub-secondary-filters">
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
    <fieldset>
      <legend>{label}</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={`hub-filter-chip ${value === option.value ? "hub-filter-chip-active" : ""}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function TraceStat({
  value,
  label,
  eyebrow,
  icon,
}: {
  value: string;
  label: string;
  eyebrow: string;
  icon: "archive" | "signal" | "review" | "violet";
}) {
  const symbols = { archive: "▣", signal: "≋", review: "●", violet: "◈" };
  return (
    <section className="hub-stat-card">
      <div className={`hub-stat-icon hub-stat-icon-${icon}`} aria-hidden="true">
        {symbols[icon]}
      </div>
      <div>
        <p className="text-sm font-black text-emerald-950/74">{eyebrow}</p>
        <p className="mt-2 text-sm text-emerald-950/44">{label}</p>
        <p className="mt-4 text-4xl font-black tracking-[-.07em] text-[#082e27]">{value}</p>
      </div>
    </section>
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
      className={`${compact ? "mt-5" : "mt-8"} grid grid-cols-[minmax(0,1fr)] gap-4 ${viewMode === "grid" ? "md:grid-cols-2 xl:grid-cols-3" : ""}`}
      role="status"
    >
      {[0, 1, 2].map((item) => (
        <div
          key={item}
          className={`${viewMode === "grid" ? "h-[16.75rem]" : "h-32"} animate-pulse rounded-[1.5rem] border border-emerald-950/8 bg-white/70`}
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
          ? "hub-results-grid mt-5 grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 xl:grid-cols-3 xl:gap-5"
          : "hub-results-list mt-5"
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
      <span className="text-emerald-950/55">
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="hub-page-button bg-white text-emerald-950"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="hub-page-button bg-emerald-950 text-white"
        >
          Next
        </button>
      </div>
    </div>
  );
}
