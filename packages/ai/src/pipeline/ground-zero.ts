import type { EvidenceSource, GroundZeroResult } from "./types.js";
export function traceGroundZero(sources: EvidenceSource[]): GroundZeroResult {
  const candidates = deduplicateCandidates(sources)
    .filter(
      (source) =>
        source.url &&
        source.publishedAt &&
        Number.isFinite(Date.parse(source.publishedAt)),
    )
    .sort(
      (left, right) =>
        Date.parse(left.publishedAt!) - Date.parse(right.publishedAt!),
    );
  const earliestSource = candidates[0] ?? null;
  if (!earliestSource) {
    return {
      status: "not_found",
      earliestSource: null,
      candidates: [],
      confidence: "low",
      signals: [
        "No retrieved source exposed a reliable publication timestamp.",
      ],
      explanation: "No timestamped source was found in retrieved evidence.",
    };
  }

  const independentDomains = new Set(
    candidates.map((source) => source.sourceDomain).filter(Boolean),
  ).size;
  const earliestDate = Date.parse(earliestSource.publishedAt!);
  const laterIndependentSources = candidates.filter(
    (source) =>
      source.sourceDomain !== earliestSource.sourceDomain &&
      Date.parse(source.publishedAt!) >= earliestDate,
  ).length;
  const signals = [
    `Earliest retrieved timestamp: ${new Date(earliestDate).toISOString()}.`,
    `${independentDomains} independent source domain${independentDomains === 1 ? "" : "s"} found.`,
  ];
  if (laterIndependentSources > 0) {
    signals.push(
      `${laterIndependentSources} later source${laterIndependentSources === 1 ? "" : "s"} independently reported the topic.`,
    );
  }
  return {
    status: "candidate",
    earliestSource,
    candidates: candidates.slice(0, 10),
    confidence:
      independentDomains >= 2 && laterIndependentSources > 0
        ? "moderate"
        : "low",
    signals,
    explanation:
      "This is the earliest de-duplicated timestamp among retrieved publisher URLs. It is an origin candidate, not proof of first publication.",
  };
}

function deduplicateCandidates(sources: EvidenceSource[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (source.type === "corpus" || !source.url) return false;
    const key = `${source.sourceDomain ?? ""}:${source.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
