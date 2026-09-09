import { z } from "zod";
import type { AiProvider, AiRequestOptions } from "../provider";
import { safeFetch } from "../safe-fetch";
import type { NormalizedInput } from "./types";
import { extractExifMetadata } from "./image-metadata";

const ARTICLE_FETCH_TIMEOUT_MS = 15_000;
const MAX_ARTICLE_BYTES = 2_000_000;
const MIN_READER_ARTICLE_CHARACTERS = 160;
const MIN_READER_ARTICLE_WORDS = 20;

export type RawAnalysisInput = {
  text?: string;
  url?: string;
  /** Clients can provide already-readable page text plus its source. */
  sourceUrl?: string;
  image?: string;
  imageMimeType?: string;
};

export async function normalizeInput(
  input: RawAnalysisInput,
  provider: AiProvider,
  options: AiRequestOptions = {},
): Promise<NormalizedInput> {
  options.signal?.throwIfAborted();
  if (input.url) return normalizeUrl(input.url, options.signal);
  if (input.image) {
    const text = await extractImageText(input.image, input.imageMimeType, provider, options.signal);
    return {
      inputType: "image",
      rawInput: input.image,
      text,
      imageMetadata: {
        mimeType: input.imageMimeType,
        textExtractionProvider: "ai_provider",
        reverseSearchUrl: getReverseImageSearchUrl(input.image),
        exif: extractExifMetadata(input.image),
      },
    };
  }

  const text = input.text?.trim();
  if (!text) throw new Error("Provide non-empty text, a URL, or an image URL/data URI.");

  // The UI has separate modes, but pasted links should still be analyzed as links.
  // Otherwise a URL reaches the LLM as if it were article text and produces no claims.
  if (isHttpUrl(text)) return normalizeUrl(text, options.signal);
  const sourceUrl = input.sourceUrl && isHttpUrl(input.sourceUrl) ? input.sourceUrl : undefined;
  return {
    inputType: "text",
    rawInput: sourceUrl ?? text,
    text,
    sourceUrl,
    sourceDomain: sourceUrl ? sourceDomain(sourceUrl) : undefined,
  };
}

async function normalizeUrl(value: string, signal?: AbortSignal): Promise<NormalizedInput> {
  const requestedUrl = new URL(value);
  const response = await fetchPublicDocument(requestedUrl, signal);
  if (!response.ok) {
    const readerResponse = await fetchReaderFallback(requestedUrl, signal);
    let readerArticle: ReturnType<typeof parseReaderDocument> | undefined;
    if (readerResponse?.ok) {
      try {
        const markdown = await readTextWithLimit(readerResponse, MAX_ARTICLE_BYTES);
        readerArticle = parseReaderDocument(markdown);
        if (!isReaderErrorDocument(readerArticle) && isReadableArticleText(readerArticle.text)) {
          return {
            inputType: "link",
            rawInput: value,
            title: readerArticle.title,
            text: readerArticle.text.slice(0, 50_000),
            sourceUrl: requestedUrl.href,
            sourceDomain: sourceDomain(requestedUrl.href),
            publishedAt: readerArticle.publishedAt,
            author: readerArticle.author,
          };
        }
      } catch (error) {
        console.warn("Could not read article reader response", error);
      }
    }

    // Some anti-bot pages cause readers to fail or return only the lead image's
    // alt text. The article slug still contains a useful, publisher-authored
    // headline, which is enough to start claim and evidence retrieval without
    // pretending that the image caption is the article body.
    const headline = articleTitleFromUrl(requestedUrl);
    if (headline) {
      return {
        inputType: "link",
        rawInput: value,
        title: headline,
        text: `Headline: ${headline}`,
        sourceUrl: requestedUrl.href,
        sourceDomain: sourceDomain(requestedUrl.href),
        publishedAt: readerArticle?.publishedAt,
        author: readerArticle?.author,
      };
    }
  }
  if (!response.ok) {
    throw new Error(`Could not retrieve link (HTTP ${response.status}).`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    contentType &&
    !contentType.includes("text/html") &&
    !contentType.includes("application/xhtml+xml")
  ) {
    throw new Error("The link must point to an HTML article.");
  }

  const html = await readTextWithLimit(response, MAX_ARTICLE_BYTES);
  const text = extractReadableText(html);
  if (text.length < 40) throw new Error("The link did not contain enough readable article text.");

  const finalUrl = response.url;
  return {
    inputType: "link",
    rawInput: value,
    title:
      metaContent(html, "og:title") ??
      (decode(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || undefined),
    text: text.slice(0, 50_000),
    sourceUrl: finalUrl,
    sourceDomain: sourceDomain(finalUrl),
    publishedAt: metaContent(html, "article:published_time") ?? metaContent(html, "datepublished"),
    author: metaContent(html, "author"),
  };
}

async function fetchReaderFallback(sourceUrl: URL, signal?: AbortSignal) {
  try {
    // The source URL has already passed the public-host SSRF check above. The
    // reader receives only that public URL and no Tracera credentials or data.
    const target = new URL(sourceUrl.href);
    target.hash = "";
    return await fetchPublicDocument(new URL(`https://r.jina.ai/${target.href}`), signal);
  } catch (error) {
    signal?.throwIfAborted();
    console.warn("Article reader fallback failed", error);
    return undefined;
  }
}

export function parseReaderDocument(markdown: string) {
  const contentMarker = "Markdown Content:";
  const markerIndex = markdown.indexOf(contentMarker);
  const text = (
    markerIndex >= 0 ? markdown.slice(markerIndex + contentMarker.length) : markdown
  ).trim();
  return {
    text,
    title: readerField(markdown, "Title"),
    publishedAt: readerField(markdown, "Published Time"),
    author: readerField(markdown, "Author"),
    warning: readerField(markdown, "Warning"),
  };
}

export function isReaderErrorDocument(article: ReturnType<typeof parseReaderDocument>) {
  return (
    /^(?:page\s+)?not found|^error\b|^access denied$/i.test(article.title?.trim() ?? "") ||
    /returned error (?:4\d\d|5\d\d)/i.test(article.warning ?? "")
  );
}

export function isReadableArticleText(text: string) {
  return (
    text.length >= MIN_READER_ARTICLE_CHARACTERS &&
    text.trim().split(/\s+/).length >= MIN_READER_ARTICLE_WORDS
  );
}

export function articleTitleFromUrl(url: URL) {
  for (const encodedSlug of url.pathname.split("/").filter(Boolean).reverse()) {
    let slug: string;
    try {
      slug = decodeURIComponent(encodedSlug);
    } catch {
      continue;
    }
    const title = slug
      .replace(/\.(?:html?|shtml?|cms)$/i, "")
      .replace(/-?\d{5,}$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = title.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (title.length < 30 || words.length < 5) continue;
    return title[0]!.toLocaleUpperCase() + title.slice(1);
  }
  return undefined;
}

function readerField(markdown: string, name: string) {
  const match = markdown.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || undefined;
}

async function fetchPublicDocument(initialUrl: URL, signal?: AbortSignal): Promise<Response> {
  return safeFetch(initialUrl, {
    headers: { "user-agent": "Tracera/1.0 (+news verification)" },
    signal: signalWithTimeout(signal, ARTICLE_FETCH_TIMEOUT_MS),
  });
}

async function readTextWithLimit(response: Response, maximumBytes: number) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error("The linked article is too large to analyze.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new Error("The linked article is too large to analyze.");
    }
    chunks.push(value);
  }
  const document = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    document.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(document);
}

function extractReadableText(html: string) {
  const body =
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ??
    html;
  return decode(
    body
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|nav|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function metaContent(html: string, name: string) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const key = tag.match(/(?:name|property)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (key !== name.toLowerCase()) continue;
    return tag.match(/content=["']([^"']+)["']/i)?.[1];
  }
  return undefined;
}

async function extractImageText(
  image: string,
  mimeType: string | undefined,
  provider: AiProvider,
  signal?: AbortSignal,
) {
  const result = await provider.generateFromImage(
    "Transcribe all visible text exactly. Preserve names, dates, numbers, captions, and source labels. Do not infer text that is not visible.",
    { data: image, mimeType },
    z.object({ text: z.string().min(1) }),
    { signal },
  );
  return result.text;
}

function getReverseImageSearchUrl(image: string) {
  if (/^https?:\/\//i.test(image)) {
    return `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(image)}`;
  }
  return undefined;
}

function signalWithTimeout(signal: AbortSignal | undefined, milliseconds: number) {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function sourceDomain(value: string) {
  return new URL(value).hostname.replace(/^www\./, "");
}

function decode(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol);
  } catch {
    return false;
  }
}
