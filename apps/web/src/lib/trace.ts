import type { TraceraScore } from "@repo/contracts";

/** A listed check, as returned by the personal history endpoint. */
export type TraceSummary = {
  id: string;
  headline: string;
  rawInput: string;
  traceraScore: TraceraScore;
  createdAt: string;
  sourceDomain: string | null;
  publishedAt: string | null;
};
