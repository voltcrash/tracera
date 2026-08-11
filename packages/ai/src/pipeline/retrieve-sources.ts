import { findRelatedClaimsByEmbedding, getDomainTrustScores } from "@repo/db";
import type { AiProvider } from "../provider.js";
import type { EvidenceSource, ExtractedClaim } from "./types.js";

const MAX_EVIDENCE_SOURCES = 5;
// Analysis runs inside a Cloudflare Worker. Keep evidence discovery bounded so
// a three-claim trace leaves enough of the 50-subrequest Free-plan allowance
// for AI calls, database reads, archive checks, and the final transaction.
const DEFAULT_EXTERNAL_REQUEST_LIMIT = 5;

type EvidenceFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response | undefined>;

type BudgetedEvidenceFetch = EvidenceFetch & { remaining: () => number };

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
  storyContext?: string;
  submittedSource?: EvidenceSource;
  /** Primarily exposed for stricter runtimes and deterministic tests. */
  externalRequestLimit?: number;
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
  const evidenceFetch = limitedFetch(
    options.externalRequestLimit ?? DEFAULT_EXTERNAL_REQUEST_LIMIT,
  );
  const corpusPromise = safelyRetrieve("corpus", () =>
    retrieveCorpusSources(
      claim,
      options.provider,
      options.claimEmbedding,
      options.corpusSimilarityThreshold ?? 0.78,
      options.corpusLimit ?? 5,
    ),
  );

  // Guarantee the resilient, no-key news index a request before optional or
  // rate-limited providers can consume the shared Worker budget.
  const primaryGoogleNews = await safelyRetrieve("Google News RSS", () =>
    retrieveGoogleNewsSources(
      claim,
      claim.claimText,
      evidenceFetch,
      options.storyContext,
    ),
  );
  const contextualQuery = buildContextualQuery(claim, options.storyContext);
  const contextualGoogleNews =
    primaryGoogleNews.length < 2 &&
    contextualQuery !== claim.claimText &&
    evidenceFetch.remaining() > 0
      ? await safelyRetrieve("contextual Google News RSS", () =>
          retrieveGoogleNewsSources(
            claim,
            contextualQuery,
            evidenceFetch,
            options.storyContext,
          ),
        )
      : [];
  const bingNews =
    primaryGoogleNews.length + contextualGoogleNews.length < 2 &&
    evidenceFetch.remaining() > 0
      ? await safelyRetrieve("Bing News RSS", () =>
          retrieveBingNewsSources(
            claim,
            contextualQuery,
            evidenceFetch,
            options.storyContext,
          ),
        )
      : [];

  const [corpus, factChecks, newsApi, webSearch] = await Promise.all([
    corpusPromise,
    safelyRetrieve("Google Fact Check", () =>
      retrieveGoogleFactCheckSources(
        claim,
        options.factCheckApiKey,
        options.factCheckLimit ?? 5,
        evidenceFetch,
        options.storyContext,
      ),
    ),
    safelyRetrieve("NewsAPI", () =>
      retrieveNewsApiSources(
        claim,
        options.newsApiKey,
        evidenceFetch,
        options.storyContext,
      ),
    ),
    safelyRetrieve("web search", () =>
      retrieveWebSearchSources(
        claim,
        options.webSearchEndpoint,
        options.webSearchApiKey,
        evidenceFetch,
        options.storyContext,
      ),
    ),
  ]);

  const initialCandidates = [
    ...primaryGoogleNews,
    ...contextualGoogleNews,
    ...bingNews,
    ...factChecks,
    ...newsApi,
    ...webSearch,
  ];
  const gdelt =
    initialCandidates.length < 2 && evidenceFetch.remaining() > 0
      ? await safelyRetrieve("GDELT", () =>
          retrieveGdeltSources(claim, evidenceFetch, options.storyContext),
        )
      : [];
  // Treat retrieval APIs as candidate generators. Nothing reaches the model
  // until it has passed a deterministic subject-relevance gate.
  const deduplicated = deduplicateSources([
    ...(options.submittedSource ? [options.submittedSource] : []),
    ...corpus,
    ...factChecks,
    ...newsApi,
    ...gdelt,
    ...primaryGoogleNews,
    ...contextualGoogleNews,
    ...bingNews,
    ...webSearch,
  ]);
  const trust = await safelyGetDomainTrustScores(deduplicated);
  const ranked = rankAndLimitSources(
    claim,
    deduplicated.map((source) => ({
      ...source,
      credibility: source.sourceDomain
        ? (trust.get(source.sourceDomain) ?? defaultCredibility(source.type))
        : defaultCredibility(source.type),
    })),
    options.storyContext,
  );
  return enrichEvidenceSnippets(ranked, evidenceFetch);
}

/**
 * Search-result descriptions are useful candidates but are not sufficient
 * evidence by themselves. For publisher URLs, refresh the snippet from the
 * document's description/lead text before it reaches verdict generation.
 */
async function enrichEvidenceSnippets(
  sources: EvidenceSource[],
  evidenceFetch: EvidenceFetch,
) {
  return Promise.all(
    sources.map(async (source) => {
      if (
        !source.url ||
        source.type === "corpus" ||
        source.type === "submitted_source"
      )
        return source;
      const metadata = await retrieveArticleMetadata(source.url, evidenceFetch);
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
  evidenceFetch: EvidenceFetch,
  storyContext?: string,
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

  const response = await evidenceFetch(url);
  if (!response) return [];
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
    .filter((source) => passesRelevanceGate(claim, source, storyContext));
}

async function retrieveNewsApiSources(
  claim: ExtractedClaim,
  apiKey?: string,
  evidenceFetch: EvidenceFetch = limitedFetch(DEFAULT_EXTERNAL_REQUEST_LIMIT),
  storyContext?: string,
): Promise<EvidenceSource[]> {
  if (!apiKey) return [];
  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", claim.claimText);
  url.searchParams.set("pageSize", "8");
  url.searchParams.set("sortBy", "relevancy");
  const response = await evidenceFetch(url, {
    headers: { "X-Api-Key": apiKey },
  });
  if (!response) return [];
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
    .filter((source) => passesRelevanceGate(claim, source, storyContext));
}

async function retrieveGdeltSources(
  claim: ExtractedClaim,
  evidenceFetch: EvidenceFetch,
  storyContext?: string,
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
  const response = await requestGdelt(url, evidenceFetch);
  if (!response) return [];
  const payload = (await response.json()) as {
    articles?: Array<{
      title: string;
      url: string;
      domain?: string;
      seendate?: string;
    }>;
  };
  const claimTerms = significantTerms(claim.claimText);
  const sources = (payload.articles ?? []).map((article, index) => {
    return {
      id: `gdelt:${index}`,
      type: "gdelt" as const,
      title: article.title,
      url: article.url,
      sourceDomain: article.domain ?? domain(article.url),
      similarity: sourceRelevance(claimTerms, article.title),
      publishedAt: normalizeGdeltDate(article.seendate),
    };
  });
  return sources.filter((source) =>
    passesRelevanceGate(claim, source, storyContext),
  );
}

async function requestGdelt(url: URL, evidenceFetch: EvidenceFetch) {
  if (Date.now() < gdeltUnavailableUntil) {
    throw new Error(
      "GDELT is temporarily unavailable after a recent connection failure.",
    );
  }
  let resolveRequest!: (response: Response | undefined) => void;
  let rejectRequest!: (error: unknown) => void;
  const result = new Promise<Response | undefined>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });

  gdeltQueue = gdeltQueue.then(async () => {
    try {
      const waitMs = Math.max(0, 6_000 - (Date.now() - lastGdeltRequestAt));
      if (waitMs > 0) await delay(waitMs);
      lastGdeltRequestAt = Date.now();
      let response = await fetchGdelt(url, evidenceFetch);
      if (!response) {
        resolveRequest(undefined);
        return;
      }
      if (response.status === 429) {
        await delay(6_000);
        lastGdeltRequestAt = Date.now();
        response = await fetchGdelt(url, evidenceFetch);
        if (!response) {
          resolveRequest(undefined);
          return;
        }
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

function fetchGdelt(url: URL, evidenceFetch: EvidenceFetch) {
  return evidenceFetch(url, {
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

async function retrieveArticleMetadata(
  url: string,
  evidenceFetch: EvidenceFetch,
): Promise<ArticleMetadata> {
  try {
    const response = await evidenceFetch(url, {
      headers: { "user-agent": "Tracera/1.0 (+news verification)" },
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response) return {};
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

/**
 * Google News exposes a public RSS endpoint which is useful as a resilient
 * candidate generator for very recent stories. Results are still subject to
 * the same relevance gate and domain credibility scoring as every other
 * retrieval provider; the aggregator itself is never treated as evidence.
 */
async function retrieveGoogleNewsSources(
  claim: ExtractedClaim,
  query: string,
  evidenceFetch: EvidenceFetch,
  storyContext?: string,
): Promise<EvidenceSource[]> {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query.slice(0, 700));
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");

  const response = await evidenceFetch(url, {
    headers: { "user-agent": "Tracera/1.0 (+news verification)" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response) return [];
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
      return passesRelevanceGate(claim, source, storyContext) ? [source] : [];
    })
    .slice(0, 12);
}

/** Independent no-key fallback for periods when Google News throttles Worker
 * egress. Bing redirect URLs are resolved back to publisher URLs before they
 * enter ranking, provenance, or Ground Zero. */
async function retrieveBingNewsSources(
  claim: ExtractedClaim,
  query: string,
  evidenceFetch: EvidenceFetch,
  storyContext?: string,
): Promise<EvidenceSource[]> {
  const url = new URL("https://www.bing.com/news/search");
  url.searchParams.set("q", query.slice(0, 700));
  url.searchParams.set("format", "rss");
  const response = await evidenceFetch(url, {
    headers: { "user-agent": "Tracera/1.0 (+news verification)" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response?.ok) return [];

  const xml = await response.text();
  return (xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? [])
    .flatMap((item, index) => {
      const title = xmlValue(item, "title");
      const resultUrl = bingPublisherUrl(xmlValue(item, "link"));
      if (!title || !resultUrl) return [];
      const source: EvidenceSource = {
        id: `bing-news:${index}`,
        type: "publisher_rss",
        title,
        url: resultUrl,
        publisher: xmlValue(item, "News:Source"),
        sourceDomain: domain(resultUrl),
        snippet: stripMarkup(xmlValue(item, "description")).slice(0, 1_200),
        publishedAt: normalizeFeedDate(xmlValue(item, "pubDate")),
      };
      return passesRelevanceGate(claim, source, storyContext) ? [source] : [];
    })
    .slice(0, 12);
}

function bingPublisherUrl(value?: string) {
  if (!value) return undefined;
  try {
    const result = new URL(value);
    const publisher = result.searchParams.get("url");
    return publisher && /^https?:\/\//i.test(publisher) ? publisher : value;
  } catch {
    return undefined;
  }
}

function sourceRelevance(claimTerms: Set<string>, text: string) {
  if (claimTerms.size === 0) return 0;
  const itemTerms = significantTerms(text);
  const overlap = termOverlap(claimTerms, itemTerms);
  return overlap < 2 ? 0 : Math.min(overlap / Math.min(claimTerms.size, 8), 1);
}

function termOverlap(left: Set<string>, right: Set<string>) {
  return [...left].filter((term) => right.has(term)).length;
}

function buildContextualQuery(claim: ExtractedClaim, storyContext?: string) {
  const additions = [claim.context, storyContext?.slice(0, 420)]
    .map((value) => value?.replace(/\s+/g, " ").trim())
    .filter((value): value is string => Boolean(value))
    .filter(
      (value) => !claim.claimText.toLowerCase().includes(value.toLowerCase()),
    );
  return [claim.claimText, ...additions].join(" ").slice(0, 700);
}

function retrievalContext(claim: ExtractedClaim, storyContext?: string) {
  return [claim.claimText, claim.context, storyContext?.slice(0, 1_000)]
    .filter(Boolean)
    .join(" ");
}

function normalizeTerm(value: string) {
  const numberWords: Record<string, string> = {
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    ten: "10",
    eleven: "11",
    twelve: "12",
    thirteen: "13",
    fourteen: "14",
    fifteen: "15",
    sixteen: "16",
    seventeen: "17",
    eighteen: "18",
    nineteen: "19",
    twenty: "20",
  };
  const number = numberWords[value];
  if (number) return number;
  const spelling = value
    .replace(/^hospitalis/, "hospitaliz")
    .replace(/^organisation/, "organization");
  return spelling.length > 4 &&
    spelling.endsWith("s") &&
    !spelling.endsWith("ss")
    ? spelling.slice(0, -1)
    : spelling;
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
    "incident",
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
      .filter((word) => word.length >= 2 && !stopWords.has(word))
      .map(normalizeTerm)
      .filter((word) => word.length >= 2),
  );
}

/**
 * A source must be about the same concrete subject, not simply share generic
 * news vocabulary. This hard boundary is applied to every source type,
 * including generic web search and publisher RSS feeds.
 */
function passesRelevanceGate(
  claim: ExtractedClaim,
  source: EvidenceSource,
  storyContext?: string,
) {
  if (!source.title.trim() || (source.type !== "corpus" && !source.url))
    return false;
  const sourceText = `${source.title} ${source.claimText ?? ""} ${source.snippet ?? ""}`;
  const claimTerms = significantTerms(claim.claimText);
  const sourceTerms = significantTerms(sourceText);
  const directRelevance = sourceRelevance(claimTerms, sourceText);
  const contextualRelevance = sourceRelevance(
    significantTerms(retrievalContext(claim, storyContext)),
    sourceText,
  );
  if (directRelevance === 0 && termOverlap(claimTerms, sourceTerms) === 0)
    return false;
  const relevance = Math.max(directRelevance, contextualRelevance * 0.85);
  source.similarity = relevance;

  const anchors = anchorTerms(claim.claimText);
  if (anchors.length > 0 && !anchors.some((anchor) => sourceTerms.has(anchor)))
    return false;

  return relevance >= 0.24;
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
        .map((word) => normalizeTerm(word.toLowerCase()))
        .filter((word) => word.length >= 2),
    ),
  ];
}

function rankAndLimitSources(
  claim: ExtractedClaim,
  sources: EvidenceSource[],
  storyContext?: string,
) {
  return sources
    .filter((source) => passesRelevanceGate(claim, source, storyContext))
    .sort((left, right) => sourceRank(right) - sourceRank(left))
    .slice(0, MAX_EVIDENCE_SOURCES);
}

function sourceRank(source: EvidenceSource) {
  const sourcePriority: Record<EvidenceSource["type"], number> = {
    submitted_source: -0.1,
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
  evidenceFetch: EvidenceFetch = limitedFetch(DEFAULT_EXTERNAL_REQUEST_LIMIT),
  storyContext?: string,
): Promise<EvidenceSource[]> {
  if (!endpoint || !apiKey) return [];
  const url = new URL(endpoint);
  url.searchParams.set("q", claim.claimText);
  const response = await evidenceFetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response) return [];
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
    .filter((source) => passesRelevanceGate(claim, source, storyContext));
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
  return type === "google_fact_check"
    ? 0.85
    : type === "corpus"
      ? 0.75
      : type === "submitted_source"
        ? 0.45
        : 0.5;
}

async function safelyGetDomainTrustScores(sources: EvidenceSource[]) {
  try {
    return await getDomainTrustScores(
      sources.map((source) => source.sourceDomain ?? ""),
    );
  } catch (error) {
    console.warn(
      "Tracera domain trust lookup failed; using source-class defaults.",
      error,
    );
    return new Map<string, number>();
  }
}

function limitedFetch(limit: number): BudgetedEvidenceFetch {
  let remaining = Number.isInteger(limit) && limit > 0 ? limit : 0;
  const budgetedFetch: BudgetedEvidenceFetch = async (input, init) => {
    if (remaining <= 0) return undefined;
    remaining -= 1;
    return fetch(input, init);
  };
  budgetedFetch.remaining = () => remaining;
  return budgetedFetch;
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
