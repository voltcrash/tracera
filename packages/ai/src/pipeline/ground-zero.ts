import type { EvidenceSource, GroundZeroResult } from "./types.js";
type CorpusHistory = GroundZeroResult["corpusHistory"];
type GroundZeroRelationship = GroundZeroResult["relationships"][number];

export function traceGroundZero(
  sources: EvidenceSource[],
  corpusHistory: CorpusHistory = [],
): GroundZeroResult {
  const timestampedSources = sources
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
  const candidates = deduplicateCandidates(timestampedSources);
  const earliestSource = candidates[0] ?? null;
  if (!earliestSource) {
    return {
      status: corpusHistory.length ? "inconclusive" : "not_found",
      earliestSource: null,
      candidates: [],
      confidence: "low",
      signals: [
        "No retrieved source exposed a reliable publication timestamp.",
      ],
      explanation:
        "No timestamped publisher source was found in retrieved evidence.",
      relationships: [],
      corpusHistory,
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
  const earliestUrl = canonical(earliestSource);
  const relationships: GroundZeroRelationship[] = [];
  for (const source of timestampedSources) {
    const sourceUrl = canonical(source);
    if (source.id === earliestSource.id) {
      relationships.push({ sourceId: source.id, relation: "publisher" });
      continue;
    }
    if (sourceUrl === earliestUrl) {
      relationships.push({
        sourceId: source.id,
        relation: "repost",
        targetUrl: earliestUrl,
      });
      continue;
    }
    if (source.citedUrls?.some((url) => sameUrl(url, earliestUrl))) {
      relationships.push({
        sourceId: source.id,
        relation: "cites_earlier_source",
        targetUrl: earliestUrl,
      });
    }
  }
  for (const item of corpusHistory) {
    relationships.push({
      sourceId: `corpus:${item.checkId}`,
      relation: "corpus_history",
      targetUrl: item.sourceUrl ?? undefined,
    });
  }
  const reposts = relationships.filter(
    (item) => item.relation === "repost",
  ).length;
  const citations = relationships.filter(
    (item) => item.relation === "cites_earlier_source",
  ).length;
  const signals = [
    `Earliest publisher timestamp: ${new Date(earliestDate).toISOString()}.`,
    `${independentDomains} independent source domain${independentDomains === 1 ? "" : "s"} found.`,
  ];
  if (laterIndependentSources > 0) {
    signals.push(
      `${laterIndependentSources} later source${laterIndependentSources === 1 ? "" : "s"} independently reported the topic.`,
    );
  }
  if (reposts)
    signals.push(
      `${reposts} retrieved result${reposts === 1 ? "" : "s"} resolves to the same canonical publisher URL.`,
    );
  if (citations)
    signals.push(
      `${citations} later publisher source${citations === 1 ? "" : "s"} explicitly cites the origin candidate.`,
    );
  if (corpusHistory.length)
    signals.push(
      `${corpusHistory.length} matching trace${corpusHistory.length === 1 ? "" : "s"} found in Tracera's history.`,
    );
  const confidence =
    independentDomains >= 3 && (citations > 0 || reposts > 0)
      ? "high"
      : independentDomains >= 2 && laterIndependentSources > 0
        ? "moderate"
        : "low";
  return {
    status: "candidate",
    earliestSource,
    candidates: candidates.slice(0, 10),
    confidence,
    signals,
    explanation:
      "This is the earliest publisher-declared timestamp after canonical-URL and explicit-citation checks. It remains an origin candidate, not proof of first publication on the web.",
    relationships,
    corpusHistory,
  };
}

function deduplicateCandidates(sources: EvidenceSource[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (source.type === "corpus" || !source.url) return false;
    const key =
      canonical(source) ??
      `${source.sourceDomain ?? ""}:${source.title.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canonical(source: EvidenceSource) {
  return source.canonicalUrl ?? source.url;
}

function sameUrl(left: string, right: string | undefined) {
  if (!right) return false;
  try {
    const normalize = (value: string) => {
      const url = new URL(value);
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
      }
      return url.toString().replace(/\/$/, "");
    };
    return normalize(left) === normalize(right);
  } catch {
    return left === right;
  }
}
