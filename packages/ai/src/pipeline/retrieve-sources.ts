import { findRelatedClaimsByEmbedding, getDomainTrustScores } from "@repo/db";
import type { AiProvider } from "../provider.js";
import type { EvidenceSource, ExtractedClaim } from "./types.js";

const MAX_EVIDENCE_SOURCES = 5;

interface RetrieveSourcesOptions {
  provider: AiProvider;
  factCheckApiKey?: string;
  corpusSimilarityThreshold?: number;
  corpusLimit?: number;
  factCheckLimit?: number;
  newsApiKey?: string;
  webSearchEndpoint?: string;
  webSearchApiKey?: string;
  claimEmbedding?: number[];
}

interface FactCheckResponse {
  claims?: Array<{
    text?: string;
    claimant?: string;
    claimReview?: Array<{
      url?: string;
      title?: string;
      reviewDate?: string;
      textualRating?: string;
      publisher?: { name?: string; site?: string };
    }>;
  }>;
  error?: { message?: string };
}

let gdeltQueue: Promise<void> = Promise.resolve();
let lastGdeltRequestAt = 0;
let gdeltUnavailableUntil = 0;

/** Retrieves only today-approved source classes. */
export async function retrieveSources(
  claim: ExtractedClaim,
  options: RetrieveSourcesOptions,
): Promise<EvidenceSource[]> {
  const [
    corpus,
    factChecks,
    newsApi,
    gdelt,
    publisherFeeds,
    googleNews,
    webSearch,
  ] = await Promise.all([
    safelyRetrieve("corpus", () =>
      retrieveCorpusSources(
        claim,
        options.provider,
        options.claimEmbedding,
        options.corpusSimilarityThreshold ?? 0.78,
        options.corpusLimit ?? 5,
      ),
    ),
    safelyRetrieve("Google Fact Check", () =>
      retrieveGoogleFactCheckSources(
        claim,
        options.factCheckApiKey,
        options.factCheckLimit ?? 5,
      ),
    ),
    safelyRetrieve("NewsAPI", () =>
      retrieveNewsApiSources(claim, options.newsApiKey),
    ),
    safelyRetrieve("GDELT", () => retrieveGdeltSources(claim)),
    safelyRetrieve("publisher feeds", () =>
      retrievePublisherFeedSources(claim),
    ),
    // Google News RSS is a no-key fallback for breaking stories. It gives
    // the pipeline a broad set of independent publisher candidates when
    // GDELT is rate limited and optional search providers are not configured.
    safelyRetrieve("Google News RSS", () => retrieveGoogleNewsSources(claim)),
    safelyRetrieve("web search", () =>
      retrieveWebSearchSources(
        claim,
        options.webSearchEndpoint,
        options.webSearchApiKey,
      ),
    ),
  ]);
  // Treat retrieval APIs as candidate generators. Nothing reaches the model
  // until it has passed a deterministic subject-relevance gate.
  const deduplicated = deduplicateSources([
    ...corpus,
    ...factChecks,
    ...newsApi,
    ...gdelt,
    ...publisherFeeds,
    ...googleNews,
    ...webSearch,
  ]);
  const trust = await getDomainTrustScores(
    deduplicated.map((source) => source.sourceDomain ?? ""),
  );
  const ranked = rankAndLimitSources(
    claim,
    deduplicated.map((source) => ({
      ...source,
      credibility: source.sourceDomain
        ? (trust.get(source.sourceDomain) ?? defaultCredibility(source.type))
        : defaultCredibility(source.type),
    })),
  );
  return enrichEvidenceSnippets(ranked);
}

/**
 * Search-result descriptions are useful candidates but are not sufficient
 * evidence by themselves. For publisher URLs, refresh the snippet from the
 * document's description/lead text before it reaches verdict generation.
 */
async function enrichEvidenceSnippets(sources: EvidenceSource[]) {
  return Promise.all(
    sources.map(async (source) => {
      if (!source.url || source.type === "corpus") return source;
      const metadata = await retrieveArticleMetadata(source.url);
      return {
        ...source,
        snippet: metadata.snippet ?? source.snippet,
        canonicalUrl: metadata.canonicalUrl,
        publisherPublishedAt: metadata.publishedAt,
        // Publisher dates are more useful than aggregator/index dates for
        // origin tracing, but retain the original timestamp as a fallback.
        publishedAt: metadata.publishedAt ?? source.publishedAt,
        citedUrls: metadata.citedUrls,
      };
    }),
  );
}

async function retrieveCorpusSources(
  claim: ExtractedClaim,
  provider: AiProvider,
  suppliedEmbedding: number[] | undefined,
  threshold: number,
  limit: number,
): Promise<EvidenceSource[]> {
  const embedding =
    suppliedEmbedding ?? (await provider.embed(claim.claimText));

  if (embedding.length !== 1024) {
    throw new Error(
      `Corpus embeddings must have 1024 dimensions; received ${embedding.length}.`,
    );
  }

  const matches = await findRelatedClaimsByEmbedding(
    embedding,
    threshold,
    limit,
  );
  return matches.map((row) => ({
    id: `corpus:${row.id}`,
    type: "corpus",
    title: "Previously verified Tracera claim",
    sourceDomain: row.sourceDomain,
    claimText: row.claimText,
    verdict: row.verdict,
    snippet: row.reasoning,
    publishedAt: row.createdAt,
    similarity: Number(row.similarity),
  }));
}

async function retrieveGoogleFactCheckSources(
  claim: ExtractedClaim,
  apiKey: string | undefined,
  pageSize: number,
): Promise<EvidenceSource[]> {
  if (!apiKey) {
    return [];
  }

  const url = new URL(
    "https://factchecktools.googleapis.com/v1alpha1/claims:search",
  );
  url.searchParams.set("query", claim.claimText);
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("key", apiKey);

  const response = await fetch(url);
  const payload = (await response.json()) as FactCheckResponse;

  if (!response.ok || payload.error) {
    throw new Error(
      payload.error?.message ??
        `Google Fact Check request failed with HTTP ${response.status}.`,
    );
  }

  const claimTerms = significantTerms(claim.claimText);
  return (payload.claims ?? [])
    .flatMap((factClaim, claimIndex) =>
      (factClaim.claimReview ?? []).map((review, reviewIndex) => ({
        id: `fact-check:${claimIndex}:${reviewIndex}`,
        type: "google_fact_check" as const,
        title: review.title ?? "Google Fact Check result",
        url: review.url,
        publisher: review.publisher?.name,
        sourceDomain: domain(review.publisher?.site),
        claimText: factClaim.text,
        rating: review.textualRating,
        publishedAt: review.reviewDate,
        similarity: sourceRelevance(
          claimTerms,
          `${factClaim.text ?? ""} ${review.title ?? ""}`,
        ),
      })),
    )
    .filter((source) => passesRelevanceGate(claim, source));
}

async function retrieveNewsApiSources(
  claim: ExtractedClaim,
  apiKey?: string,
): Promise<EvidenceSource[]> {
  if (!apiKey) return [];
  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", claim.claimText);
  url.searchParams.set("pageSize", "8");
  url.searchParams.set("sortBy", "relevancy");
  const response = await fetch(url, { headers: { "X-Api-Key": apiKey } });
  if (!response.ok) return [];
  const payload = (await response.json()) as {
    articles?: Array<{
      title: string;
      url: string;
      description?: string;
      publishedAt?: string;
      source?: { name?: string };
    }>;
  };
  const claimTerms = significantTerms(claim.claimText);
  return (payload.articles ?? [])
    .map((article, index) => ({
      id: `newsapi:${index}`,
      type: "newsapi" as const,
      title: article.title,
      url: article.url,
      publisher: article.source?.name,
      sourceDomain: domain(article.url),
      snippet: article.description,
      publishedAt: article.publishedAt,
      similarity: sourceRelevance(
        claimTerms,
        `${article.title} ${article.description ?? ""}`,
      ),
    }))
    .filter((source) => passesRelevanceGate(claim, source));
}

async function retrieveGdeltSources(
  claim: ExtractedClaim,
): Promise<EvidenceSource[]> {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set(
    "query",
    `${buildNewsQuery(claim.claimText)} sourcelang:english`,
  );
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", "8");
  url.searchParams.set("timespan", "1week");
  const response = await requestGdelt(url);
  const payload = (await response.json()) as {
    articles?: Array<{
      title: string;
      url: string;
      domain?: string;
      seendate?: string;
    }>;
  };
  const claimTerms = significantTerms(claim.claimText);
  const sources = await Promise.all(
    (payload.articles ?? []).map(async (article, index) => {
      const snippet = await retrieveArticleDescription(article.url);
      return {
        id: `gdelt:${index}`,
        type: "gdelt" as const,
        title: article.title,
        url: article.url,
        sourceDomain: article.domain ?? domain(article.url),
        snippet,
        similarity: sourceRelevance(
          claimTerms,
          `${article.title} ${snippet ?? ""}`,
        ),
        publishedAt: normalizeGdeltDate(article.seendate),
      };
    }),
  );
  return sources.filter((source) => passesRelevanceGate(claim, source));
}

async function requestGdelt(url: URL) {
  if (Date.now() < gdeltUnavailableUntil) {
    throw new Error(
      "GDELT is temporarily unavailable after a recent connection failure.",
    );
  }
  let resolveRequest!: (response: Response) => void;
  let rejectRequest!: (error: unknown) => void;
  const result = new Promise<Response>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });

  gdeltQueue = gdeltQueue.then(async () => {
    try {
      const waitMs = Math.max(0, 6_000 - (Date.now() - lastGdeltRequestAt));
      if (waitMs > 0) await delay(waitMs);
      lastGdeltRequestAt = Date.now();
      let response = await fetchGdelt(url);
      if (response.status === 429) {
        await delay(6_000);
        lastGdeltRequestAt = Date.now();
        response = await fetchGdelt(url);
      }
      if (!response.ok)
        throw new Error(`GDELT request failed with HTTP ${response.status}.`);
      gdeltUnavailableUntil = 0;
      resolveRequest(response);
    } catch (error) {
      gdeltUnavailableUntil = Date.now() + 5 * 60_000;
      rejectRequest(error);
    }
  });

  // A failed request must not poison the queue for later claims or users.
  gdeltQueue = gdeltQueue.catch(() => undefined);
  return result;
}

function fetchGdelt(url: URL) {
  return fetch(url, {
    headers: { "user-agent": "Tracera/1.0 (+news verification)" },
    signal: AbortSignal.timeout(20_000),
  });
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** GDELT treats whitespace-separated words as a broad AND query. Full claims
 * are therefore slow and usually return nothing. Prefer the strongest named
 * entity, then fall back to a few distinctive words. */
function buildNewsQuery(claimText: string) {
  const entityPhrases =
    claimText.match(
      /\b(?:[A-Z][\p{L}\d]*(?:\s+(?:of|the|and|[A-Z][\p{L}\d]*)){1,5})\b/gu,
    ) ?? [];
  const entity = entityPhrases
    .map((phrase) => phrase.replace(/^(?:The|An|A)\s+/, "").trim())
    .filter((phrase) => phrase.split(/\s+/).length >= 2)
    .sort((left, right) => right.length - left.length)[0];
  if (entity) return `"${entity.replace(/"/g, "")}"`;

  const stopWords = new Set([
    "about",
    "after",
    "again",
    "been",
    "before",
    "being",
    "following",
    "from",
    "have",
    "into",
    "near",
    "over",
    "reported",
    "since",
    "that",
    "their",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "under",
    "where",
    "which",
    "with",
  ]);
  const terms = claimText
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stopWords.has(word.toLowerCase()))
    .sort((left, right) => right.length - left.length)
    .slice(0, 4);
  return (
    terms.join(" ") ||
    claimText
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .trim()
      .slice(0, 80)
  );
}

interface ArticleMetadata {
  snippet?: string;
  canonicalUrl?: string;
  publishedAt?: string;
  citedUrls?: string[];
}

async function retrieveArticleMetadata(url: string): Promise<ArticleMetadata> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "Tracera/1.0 (+news verification)" },
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return {};
    const html = (await response.text()).slice(0, 250_000);
    const description =
      metaContent(html, "description") ?? metaContent(html, "og:description");
    const canonicalUrl =
      html
        .match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0]
        ?.match(/href=["']([^"']+)["']/i)?.[1] ??
      metaContent(html, "og:url") ??
      url;
    const publishedAt = normalizePublisherDate(
      metaContent(html, "article:published_time") ??
        metaContent(html, "date") ??
        metaContent(html, "datePublished") ??
        html.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1],
    );
    const citedUrls = extractCitationUrls(html, url);
    if (description)
      return { snippet: description, canonicalUrl, publishedAt, citedUrls };
    const article =
      html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
      html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
    const snippet = article
      ?.replace(/<(script|style|nav|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1_200);
    return { snippet, canonicalUrl, publishedAt, citedUrls };
  } catch {
    return {};
  }
}

async function retrieveArticleDescription(url: string) {
  return (await retrieveArticleMetadata(url)).snippet;
}

function normalizePublisherDate(value: string | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

/** Links marked as citations/sources are explicit provenance signals. */
function extractCitationUrls(html: string, baseUrl: string) {
  const matches = html.match(/<a\b[^>]*href=["'][^"']+["'][^>]*>/gi) ?? [];
  const urls = matches.flatMap((tag) => {
    const marker =
      `${tag} ${tag.match(/(?:class|rel|data-testid)=["']([^"']+)["']/i)?.[1] ?? ""}`.toLowerCase();
    if (!/(citation|source|references?|original-report)/.test(marker))
      return [];
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) return [];
    try {
      return [new URL(href, baseUrl).toString()];
    } catch {
      return [];
    }
  });
  return [...new Set(urls)].slice(0, 12);
}

function metaContent(html: string, key: string) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = tag.match(/(?:name|property)=["']([^"']+)["']/i)?.[1];
    if (name?.toLowerCase() !== key.toLowerCase()) continue;
    return tag
      .match(/content=["']([^"']+)["']/i)?.[1]
      ?.replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  return undefined;
}

function normalizeGdeltDate(value?: string) {
  const match = value?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`
    : value;
}

const PUBLISHER_FEEDS = [
  { publisher: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { publisher: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { publisher: "DW", url: "https://rss.dw.com/rdf/rss-en-world" },
  { publisher: "NPR", url: "https://feeds.npr.org/1004/rss.xml" },
  { publisher: "France 24", url: "https://www.france24.com/en/rss" },
  {
    publisher: "ABC News",
    url: "https://abcnews.com/abcnews/internationalheadlines",
  },
] as const;

async function retrievePublisherFeedSources(
  claim: ExtractedClaim,
): Promise<EvidenceSource[]> {
  const claimTerms = significantTerms(claim.claimText);
  const feeds = await Promise.all(
    PUBLISHER_FEEDS.map(async (feed) => {
      try {
        const response = await fetch(feed.url, {
          headers: { "user-agent": "Tracera/1.0 (+news verification)" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return [];
        const xml = await response.text();
        return (xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? []).flatMap(
          (item, itemIndex) => {
            const title = xmlValue(item, "title");
            const link = xmlValue(item, "link");
            const description = stripMarkup(xmlValue(item, "description"));
            const similarity = sourceRelevance(
              claimTerms,
              `${title} ${description}`,
            );
            if (!title || !link) return [];
            const source: EvidenceSource = {
              id: `rss:${feed.publisher.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${itemIndex}`,
              type: "publisher_rss" as const,
              title,
              url: link,
              publisher: feed.publisher,
              sourceDomain: domain(link),
              snippet: description.slice(0, 1_200),
              similarity,
              publishedAt: normalizeFeedDate(
                xmlValue(item, "pubDate") ?? xmlValue(item, "dc:date"),
              ),
            };
            return passesRelevanceGate(claim, source) ? [source] : [];
          },
        );
      } catch {
        return [];
      }
    }),
  );
  return feeds.flat().slice(0, 12);
}

/**
 * Google News exposes a public RSS endpoint which is useful as a resilient
 * candidate generator for very recent stories. Results are still subject to
 * the same relevance gate and domain credibility scoring as every other
 * retrieval provider; the aggregator itself is never treated as evidence.
 */
async function retrieveGoogleNewsSources(
  claim: ExtractedClaim,
): Promise<EvidenceSource[]> {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", claim.claimText.slice(0, 500));
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");

  const response = await fetch(url, {
    headers: { "user-agent": "Tracera/1.0 (+news verification)" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return [];

  const xml = await response.text();
  return (xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? [])
    .flatMap((item, index) => {
      const title = xmlValue(item, "title");
      const sourceUrl = xmlValue(item, "link");
      if (!title || !sourceUrl) return [];

      const publisher = xmlValue(item, "source");
      const publisherUrl = xmlTagAttribute(item, "source", "url");
      const source: EvidenceSource = {
        id: `google-news:${index}`,
        type: "google_news_rss",
        title,
        url: sourceUrl,
        publisher,
        sourceDomain: domain(publisherUrl) ?? domain(sourceUrl),
        snippet: stripMarkup(xmlValue(item, "description")).slice(0, 1_200),
        publishedAt: normalizeFeedDate(xmlValue(item, "pubDate")),
      };
      return passesRelevanceGate(claim, source) ? [source] : [];
    })
    .slice(0, 12);
}

function sourceRelevance(claimTerms: Set<string>, text: string) {
  if (claimTerms.size === 0) return 0;
  const itemTerms = significantTerms(text);
  const overlap = [...claimTerms].filter((term) => itemTerms.has(term)).length;
  return overlap < 2 ? 0 : overlap / Math.min(claimTerms.size, 8);
}

function significantTerms(text: string) {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "also",
    "amid",
    "been",
    "before",
    "being",
    "call",
    "could",
    "development",
    "developments",
    "following",
    "from",
    "government",
    "have",
    "into",
    "issue",
    "issues",
    "minister",
    "near",
    "outcome",
    "outcomes",
    "over",
    "party",
    "political",
    "protest",
    "protests",
    "received",
    "recent",
    "reported",
    "reports",
    "said",
    "since",
    "that",
    "their",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "under",
    "wake",
    "were",
    "where",
    "which",
    "with",
    "would",
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !stopWords.has(word)),
  );
}

/**
 * A source must be about the same concrete subject, not simply share generic
 * news vocabulary. This hard boundary is applied to every source type,
 * including generic web search and publisher RSS feeds.
 */
function passesRelevanceGate(claim: ExtractedClaim, source: EvidenceSource) {
  if (!source.title.trim() || (source.type !== "corpus" && !source.url))
    return false;
  const sourceText = `${source.title} ${source.claimText ?? ""} ${source.snippet ?? ""}`;
  const relevance = sourceRelevance(
    significantTerms(claim.claimText),
    sourceText,
  );
  source.similarity = relevance;

  const anchors = anchorTerms(claim.claimText);
  const sourceTerms = significantTerms(sourceText);
  if (anchors.length > 0 && !anchors.some((anchor) => sourceTerms.has(anchor)))
    return false;

  return relevance >= 0.28;
}

function anchorTerms(text: string) {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return [
    ...new Set(
      words
        .filter((word, index) => {
          if (/^\d/.test(word) || /^[A-Z]{2,}$/.test(word)) return true;
          // Capitalised words after the opening word are generally entity tokens.
          return (
            index > 0 &&
            /^\p{Lu}[\p{L}\d-]*$/u.test(word) &&
            !["The", "A", "An", "And", "But"].includes(word)
          );
        })
        .map((word) => word.toLowerCase())
        .filter((word) => word.length >= 2),
    ),
  ];
}

function rankAndLimitSources(claim: ExtractedClaim, sources: EvidenceSource[]) {
  return sources
    .filter((source) => passesRelevanceGate(claim, source))
    .sort((left, right) => sourceRank(right) - sourceRank(left))
    .slice(0, MAX_EVIDENCE_SOURCES);
}

function sourceRank(source: EvidenceSource) {
  const sourcePriority: Record<EvidenceSource["type"], number> = {
    google_fact_check: 0.25,
    corpus: 0.2,
    newsapi: 0.1,
    gdelt: 0.08,
    publisher_rss: 0.06,
    google_news_rss: 0.05,
    web_search: 0.04,
  };
  return (
    (source.similarity ?? 0) +
    sourcePriority[source.type] +
    (source.credibility ?? 0) * 0.1
  );
}

function xmlValue(item: string, tag: string) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = item.match(
    new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"),
  )?.[1];
  return value
    ? decodeXml(value.replace(/^<!\[CDATA\[|\]\]>$/g, "").trim())
    : undefined;
}

function stripMarkup(value?: string) {
  return decodeXml(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlTagAttribute(item: string, tag: string, attribute: string) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return item.match(
    new RegExp(
      `<${escapedTag}\\b[^>]*\\b${escapedAttribute}=["']([^"']+)["'][^>]*>`,
      "i",
    ),
  )?.[1];
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:0*39|x0*27);/gi, "'");
}

function normalizeFeedDate(value?: string) {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

async function retrieveWebSearchSources(
  claim: ExtractedClaim,
  endpoint?: string,
  apiKey?: string,
): Promise<EvidenceSource[]> {
  if (!endpoint || !apiKey) return [];
  const url = new URL(endpoint);
  url.searchParams.set("q", claim.claimText);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as {
    results?: Array<{
      title: string;
      url: string;
      snippet?: string;
      publishedAt?: string;
    }>;
  };
  const claimTerms = significantTerms(claim.claimText);
  return (payload.results ?? [])
    .slice(0, 8)
    .map((item, index) => ({
      id: `web:${index}`,
      type: "web_search" as const,
      title: item.title,
      url: item.url,
      sourceDomain: domain(item.url),
      snippet: item.snippet,
      publishedAt: item.publishedAt,
      similarity: sourceRelevance(
        claimTerms,
        `${item.title} ${item.snippet ?? ""}`,
      ),
    }))
    .filter((source) => passesRelevanceGate(claim, source));
}

function domain(value?: string) {
  if (!value) return undefined;
  try {
    return new URL(
      value.includes("://") ? value : `https://${value}`,
    ).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
function defaultCredibility(type: EvidenceSource["type"]) {
  return type === "google_fact_check" ? 0.85 : type === "corpus" ? 0.75 : 0.5;
}
async function safelyRetrieve(
  label: string,
  retrieve: () => Promise<EvidenceSource[]>,
) {
  try {
    return await retrieve();
  } catch (error) {
    console.warn(
      `Tracera ${label} retrieval failed; continuing without it.`,
      error,
    );
    return [];
  }
}
function deduplicateSources(sources: EvidenceSource[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.url
      ? `url:${source.url}`
      : `${source.type}:${source.title}:${source.sourceDomain ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
