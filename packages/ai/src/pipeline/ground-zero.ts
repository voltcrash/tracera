import type { EvidenceSource, GroundZeroResult } from "./types.js";
export function traceGroundZero(sources: EvidenceSource[]): GroundZeroResult {
  const candidates = sources.filter((source) => source.url && source.publishedAt && Number.isFinite(Date.parse(source.publishedAt))).sort((a, b) => Date.parse(a.publishedAt!) - Date.parse(b.publishedAt!)); const earliestSource = candidates[0] ?? null;
  return { status: earliestSource ? "candidate" : "not_found", earliestSource, candidates: candidates.slice(0, 10), explanation: earliestSource ? "Earliest timestamped appearance among retrieved sources; a candidate, not proof of first publication." : "No timestamped source was found in retrieved evidence." };
}
