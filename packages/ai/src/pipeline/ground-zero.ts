import type { EvidenceSource, GroundZeroResult } from "./types.js";
type CorpusHistory = GroundZeroResult["corpusHistory"];
type ArchiveHistory = GroundZeroResult["archiveHistory"];
type GroundZeroRelationship = GroundZeroResult["relationships"][number];

const SIMULTANEOUS_PUBLICATION_WINDOW_MS = 5 * 60_000;

export function traceGroundZero(
  sources: EvidenceSource[],
  corpusHistory: CorpusHistory = [],
  archiveHistory: ArchiveHistory = [],
): GroundZeroResult {
  const timestampedSources = sources
    .filter(
      (source) =>
        source.url &&
        sourceTimestamp(source) &&
        isPlausibleTimestamp(sourceTimestamp(source)!),
    )
    .sort(
      (left, right) =>
        Date.parse(sourceTimestamp(left)!) -
        Date.parse(sourceTimestamp(right)!),
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
      archiveHistory,
    };
  }

  const independentDomains = new Set(
    candidates.map((source) => source.sourceDomain).filter(Boolean),
  ).size;
  const earliestTimestamp = sourceTimestamp(earliestSource)!;
  const earliestDate = Date.parse(earliestTimestamp);
  const laterIndependentSources = candidates.filter(
    (source) =>
      source.sourceDomain !== earliestSource.sourceDomain &&
      Date.parse(sourceTimestamp(source)!) >= earliestDate,
  ).length;
  const simultaneousSources = candidates.filter(
    (source) =>
      source.sourceDomain !== earliestSource.sourceDomain &&
      Math.abs(Date.parse(sourceTimestamp(source)!) - earliestDate) <=
        SIMULTANEOUS_PUBLICATION_WINDOW_MS,
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
    for (const citedUrl of source.citedUrls ?? []) {
      const target = candidates.find((candidate) =>
        sameUrl(citedUrl, canonical(candidate)),
      );
      if (!target || target.id === source.id) continue;
      const targetUrl = canonical(target);
      const relation =
        Date.parse(sourceTimestamp(target)!) <=
        Date.parse(sourceTimestamp(source)!)
          ? "cites_earlier_source"
          : "chronology_conflict";
      relationships.push({ sourceId: source.id, relation, targetUrl });
    }
  }
  for (const item of corpusHistory) {
    relationships.push({
      sourceId: `corpus:${item.checkId}`,
      relation: "corpus_history",
      targetUrl: item.sourceUrl ?? undefined,
    });
  }
  for (const item of archiveHistory) {
    relationships.push({
      sourceId: `archive:${item.firstSeenAt}`,
      relation: "archive_snapshot",
      targetUrl: item.url,
    });
  }
  const reposts = relationships.filter(
    (item) => item.relation === "repost",
  ).length;
  const citations = relationships.filter(
    (item) =>
      item.relation === "cites_earlier_source" &&
      sameUrl(item.targetUrl ?? "", earliestUrl),
  ).length;
  const chronologyConflicts = relationships.filter(
    (item) => item.relation === "chronology_conflict",
  ).length;
  const earliestArchive = archiveHistory.find((item) =>
    sameUrl(item.url, earliestUrl),
  );
  const signals = [
    `Earliest ${earliestSource.publisherPublishedAt ? "publisher-declared" : "retrieval-index"} timestamp: ${new Date(earliestDate).toISOString()}.`,
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
  if (simultaneousSources)
    signals.push(
      `${simultaneousSources} independent source${simultaneousSources === 1 ? " was" : "s were"} published within five minutes, so exact ordering may be unreliable.`,
    );
  if (earliestArchive)
    signals.push(
      `The earliest known web archive capture is ${earliestArchive.firstSeenAt}.`,
    );
  if (chronologyConflicts)
    signals.push(
      `${chronologyConflicts} citation${chronologyConflicts === 1 ? " has" : "s have"} a timestamp conflict and cannot establish origin order.`,
    );
  const confidence =
    earliestSource.publisherPublishedAt &&
    independentDomains >= 3 &&
    (citations > 0 || reposts > 0) &&
    chronologyConflicts === 0 &&
    simultaneousSources === 0
      ? "high"
      : earliestSource.publisherPublishedAt &&
          independentDomains >= 2 &&
          laterIndependentSources > 0 &&
          chronologyConflicts === 0
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
    archiveHistory,
  };
}

/** Looks up an earliest known archive capture without treating it as a publish date. */
export async function retrieveArchiveHistory(
  sources: EvidenceSource[],
): Promise<ArchiveHistory> {
  const urls = [
    ...new Set(
      sources
        .map((source) => canonical(source))
        .filter((url): url is string => Boolean(url)),
    ),
    // Archive lookups happen after the full analysis and database retrieval.
    // Two candidates are sufficient to strengthen chronology without exhausting
    // the Worker's subrequest allowance before persistence.
  ].slice(0, 2);
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const endpoint = new URL("https://web.archive.org/cdx/search/cdx");
        endpoint.searchParams.set("url", url);
        endpoint.searchParams.set("output", "json");
        endpoint.searchParams.set("filter", "statuscode:200");
        endpoint.searchParams.append("filter", "mimetype:text/html");
        endpoint.searchParams.set("fl", "timestamp,original");
        endpoint.searchParams.set("limit", "1");
        endpoint.searchParams.set("from", "1996");
        const response = await fetch(endpoint, {
          headers: { "user-agent": "Tracera/1.0 (+origin verification)" },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return undefined;
        const payload = (await response.json()) as string[][];
        const [timestamp, original] = payload[1] ?? [];
        const firstSeenAt = archiveTimestamp(timestamp);
        if (!timestamp || !original || !firstSeenAt) return undefined;
        return {
          url,
          firstSeenAt,
          archivedUrl: `https://web.archive.org/web/${timestamp}/${original}`,
        };
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((item): item is ArchiveHistory[number] =>
    Boolean(item),
  );
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

function sourceTimestamp(source: EvidenceSource) {
  return source.publisherPublishedAt ?? source.publishedAt;
}

function isPlausibleTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    timestamp >= Date.UTC(1990, 0, 1) &&
    timestamp <= Date.now() + 24 * 60 * 60_000
  );
}

function archiveTimestamp(value: string | undefined) {
  if (!value || !/^\d{14}$/.test(value)) return undefined;
  const formatted = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`;
  return Number.isFinite(Date.parse(formatted)) ? formatted : undefined;
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
