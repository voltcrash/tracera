import { safeFetch } from "@repo/ai";
import type { ClockPort } from "@repo/ai/analysis";
import {
  createExistingDiscoveryAdapters,
  type CandidateDiscoveryClient,
  type CandidateDiscoveryResult,
  type ExistingDiscoveryClients,
} from "@repo/ai/analysis/retrieval";
import { optional, type RuntimeEnvironment } from "./analysis-policy";

export function createLiveSearchPorts(environment: RuntimeEnvironment, clock: ClockPort) {
  const clients: ExistingDiscoveryClients = {
    googleNews: rssClient((request) => {
      const url = new URL("https://news.google.com/rss/search");
      url.searchParams.set("q", request.query.slice(0, 700));
      url.searchParams.set("hl", "en-US");
      url.searchParams.set("gl", "US");
      url.searchParams.set("ceid", "US:en");
      return readRssResults(url, request.signal);
    }),
    gdelt: jsonClient(async (request) => {
      const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
      url.searchParams.set("query", request.query.slice(0, 700));
      url.searchParams.set("mode", "artlist");
      url.searchParams.set("format", "json");
      url.searchParams.set("maxrecords", String(Math.min(request.limit, 10)));
      const response = await discoveryFetch(url, request.signal);
      const payload = (await response.json()) as {
        articles?: Array<{ title?: string; url?: string; domain?: string; seendate?: string }>;
      };
      return (payload.articles ?? []).flatMap((article) =>
        article.title && article.url && isPublicHttpUrl(article.url)
          ? [
              {
                url: article.url,
                title: article.title,
                snippet: null,
                rating: article.domain ?? null,
              },
            ]
          : [],
      );
    }, 0),
  };
  const factCheckKey = optional(environment, "GOOGLE_FACT_CHECK_API_KEY");
  if (factCheckKey) clients.googleFactCheck = googleFactCheckClient(factCheckKey);
  const newsApiKey = optional(environment, "NEWS_API_KEY");
  if (newsApiKey) clients.newsApi = newsApiClient(newsApiKey);
  return createExistingDiscoveryAdapters(clients, clock);
}

function rssClient(
  read: (
    request: Parameters<CandidateDiscoveryClient["search"]>[0],
  ) => Promise<CandidateDiscoveryResult[]>,
): CandidateDiscoveryClient {
  return {
    async search(request) {
      const results = await read(request);
      // These are public, unmetered discovery transports; this is not a provider usage metric.
      return { results, costUsd: 0 };
    },
  };
}

function jsonClient(
  read: (
    request: Parameters<CandidateDiscoveryClient["search"]>[0],
  ) => Promise<CandidateDiscoveryResult[]>,
  costUsd: number | null = null,
): CandidateDiscoveryClient {
  return {
    async search(request) {
      const results = await read(request);
      return { results, costUsd };
    },
  };
}

async function readRssResults(url: URL, signal: AbortSignal): Promise<CandidateDiscoveryResult[]> {
  const response = await discoveryFetch(url, signal, { "user-agent": "Tracera/2.0" });
  const xml = await response.text();
  return (xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []).flatMap((item) => {
    const title = xmlValue(item, "title");
    const resultUrl = xmlValue(item, "link");
    if (!title || !resultUrl || !isPublicHttpUrl(resultUrl)) return [];
    return [
      {
        url: resultUrl,
        title,
        snippet: xmlValue(item, "description"),
        rating: xmlValue(item, "source"),
      },
    ];
  });
}

function googleFactCheckClient(apiKey: string): CandidateDiscoveryClient {
  return jsonClient(async (request) => {
    const url = new URL("https://factchecktools.googleapis.com/v1alpha1/claims:search");
    url.searchParams.set("query", request.query.slice(0, 700));
    url.searchParams.set("pageSize", String(Math.min(request.limit, 10)));
    url.searchParams.set("key", apiKey);
    const response = await discoveryFetch(url, request.signal);
    const payload = (await response.json()) as {
      claims?: Array<{
        text?: string;
        claimReview?: Array<{ url?: string; title?: string; publisher?: { name?: string } }>;
      }>;
    };
    return (payload.claims ?? []).flatMap((claim) =>
      (claim.claimReview ?? []).flatMap((review) =>
        review.url && isPublicHttpUrl(review.url)
          ? [
              {
                url: review.url,
                title: review.title ?? claim.text ?? null,
                snippet: claim.text ?? null,
                rating: review.publisher?.name ?? null,
              },
            ]
          : [],
      ),
    );
  });
}

function newsApiClient(apiKey: string): CandidateDiscoveryClient {
  return jsonClient(async (request) => {
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("q", request.query.slice(0, 700));
    url.searchParams.set("pageSize", String(Math.min(request.limit, 10)));
    url.searchParams.set("sortBy", "relevancy");
    const response = await discoveryFetch(url, request.signal, { "X-Api-Key": apiKey });
    const payload = (await response.json()) as {
      articles?: Array<{
        title?: string;
        url?: string;
        description?: string;
        source?: { name?: string };
      }>;
    };
    return (payload.articles ?? []).flatMap((article) =>
      article.title && article.url && isPublicHttpUrl(article.url)
        ? [
            {
              url: article.url,
              title: article.title,
              snippet: article.description ?? null,
              rating: article.source?.name ?? null,
            },
          ]
        : [],
    );
  });
}

async function discoveryFetch(
  url: URL,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
) {
  const response = await safeFetch(url, {
    signal,
    headers: { accept: "application/rss+xml, application/json, text/xml", ...extraHeaders },
  });
  if (!response.ok) throw new Error(`Discovery provider returned HTTP ${response.status}.`);
  return response;
}

function xmlValue(item: string, tag: string) {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return (
    match?.[1]
      ?.replace(/^<!\[CDATA\[|\]\]>$/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

function isPublicHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
