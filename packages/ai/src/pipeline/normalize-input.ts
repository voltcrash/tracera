import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { AiProvider } from "../provider.js";
import type { NormalizedInput } from "./types.js";
import { extractExifMetadata } from "./image-metadata.js";

const ARTICLE_FETCH_TIMEOUT_MS = 15_000;
const MAX_ARTICLE_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const MIN_READER_ARTICLE_CHARACTERS = 160;
const MIN_READER_ARTICLE_WORDS = 20;

export type RawAnalysisInput = {
  text?: string;
  url?: string;
  /** Browser extensions can provide already-readable page text plus its source. */
  sourceUrl?: string;
  image?: string;
  imageMimeType?: string;
};

export async function normalizeInput(
  input: RawAnalysisInput,
  provider: AiProvider,
): Promise<NormalizedInput> {
  if (input.url) return normalizeUrl(input.url);
  if (input.image) {
    const [text, reverseSearchUrl] = await Promise.all([
      extractImageText(input.image, input.imageMimeType, provider),
      findReverseImageSearch(input.image, input.imageMimeType),
    ]);
    return {
      inputType: "image",
      rawInput: input.image,
      text,
      imageMetadata: {
        mimeType: input.imageMimeType,
        ocrProvider: process.env.OCR_ENDPOINT ? "configured" : "model_fallback",
        reverseSearchUrl,
        exif: extractExifMetadata(input.image),
      },
    };
  }

  const text = input.text?.trim();
  if (!text)
    throw new Error("Provide non-empty text, a URL, or an image URL/data URI.");

  // The UI has separate modes, but pasted links should still be analyzed as links.
  // Otherwise a URL reaches the LLM as if it were article text and produces no claims.
  if (isHttpUrl(text)) return normalizeUrl(text);
  const sourceUrl =
    input.sourceUrl && isHttpUrl(input.sourceUrl) ? input.sourceUrl : undefined;
  return {
    inputType: "text",
    rawInput: sourceUrl ?? text,
    text,
    sourceUrl,
    sourceDomain: sourceUrl ? sourceDomain(sourceUrl) : undefined,
  };
}

async function normalizeUrl(value: string): Promise<NormalizedInput> {
  const requestedUrl = new URL(value);
  const response = await fetchPublicDocument(requestedUrl);
  if (!response.ok) {
    const readerResponse = await fetchReaderFallback(requestedUrl);
    let readerArticle: ReturnType<typeof parseReaderDocument> | undefined;
    if (readerResponse?.ok) {
      try {
        const markdown = await readTextWithLimit(
          readerResponse,
          MAX_ARTICLE_BYTES,
        );
        readerArticle = parseReaderDocument(markdown);
        if (
          !isReaderErrorDocument(readerArticle) &&
          isReadableArticleText(readerArticle.text)
        ) {
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
  if (text.length < 40)
    throw new Error("The link did not contain enough readable article text.");

  const finalUrl = response.url;
  return {
    inputType: "link",
    rawInput: value,
    title:
      metaContent(html, "og:title") ??
      (decode(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") ||
        undefined),
    text: text.slice(0, 50_000),
    sourceUrl: finalUrl,
    sourceDomain: sourceDomain(finalUrl),
    publishedAt:
      metaContent(html, "article:published_time") ??
      metaContent(html, "datepublished"),
    author: metaContent(html, "author"),
  };
}

async function fetchReaderFallback(sourceUrl: URL) {
  try {
    // The source URL has already passed the public-host SSRF check above. The
    // reader receives only that public URL and no Tracera credentials or data.
    const target = new URL(sourceUrl.href);
    target.hash = "";
    return await fetchPublicDocument(
      new URL(`https://r.jina.ai/${target.href}`),
    );
  } catch (error) {
    console.warn("Article reader fallback failed", error);
    return undefined;
  }
}

export function parseReaderDocument(markdown: string) {
  const contentMarker = "Markdown Content:";
  const markerIndex = markdown.indexOf(contentMarker);
  const text = (
    markerIndex >= 0
      ? markdown.slice(markerIndex + contentMarker.length)
      : markdown
  ).trim();
  return {
    text,
    title: readerField(markdown, "Title"),
    publishedAt: readerField(markdown, "Published Time"),
    author: readerField(markdown, "Author"),
    warning: readerField(markdown, "Warning"),
  };
}

export function isReaderErrorDocument(
  article: ReturnType<typeof parseReaderDocument>,
) {
  return (
    /^(?:page\s+)?not found|^error\b|^access denied$/i.test(
      article.title?.trim() ?? "",
    ) || /returned error (?:4\d\d|5\d\d)/i.test(article.warning ?? "")
  );
}

export function isReadableArticleText(text: string) {
  return (
    text.length >= MIN_READER_ARTICLE_CHARACTERS &&
    text.trim().split(/\s+/).length >= MIN_READER_ARTICLE_WORDS
  );
}

export function articleTitleFromUrl(url: URL) {
  const encodedSlug = url.pathname.split("/").filter(Boolean).at(-1);
  if (!encodedSlug) return undefined;

  let slug: string;
  try {
    slug = decodeURIComponent(encodedSlug);
  } catch {
    return undefined;
  }
  const title = slug
    .replace(/\.(?:html?|shtml?)$/i, "")
    .replace(/-\d{5,}$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = title.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (title.length < 30 || words.length < 5) return undefined;
  return title[0]!.toLocaleUpperCase() + title.slice(1);
}

function readerField(markdown: string, name: string) {
  const match = markdown.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || undefined;
}

/**
 * Fetches only public HTTP(S) documents, validating every redirect target.
 * This blocks loopback, RFC1918, and cloud-link-local SSRF routes before they
 * can be fetched by the API Worker.
 */
async function fetchPublicDocument(initialUrl: URL): Promise<Response> {
  let currentUrl = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicHttpUrl(currentUrl);
    const response = await fetch(currentUrl, {
      headers: { "user-agent": "Tracera/1.0 (+news verification)" },
      redirect: "manual",
      signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location)
      throw new Error("The link redirected without a destination.");
    currentUrl = new URL(location, currentUrl);
  }
  throw new Error("The link redirected too many times.");
}

async function assertPublicHttpUrl(url: URL) {
  if (!/^https?:$/.test(url.protocol))
    throw new Error("Only HTTP(S) links are supported.");
  if (url.username || url.password)
    throw new Error("Links with embedded credentials are not supported.");

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname.endsWith(".local")) {
    throw new Error("Links to local network hosts are not supported.");
  }

  const addresses = isIP(hostname)
    ? [hostname]
    : await resolveHostAddresses(hostname);
  if (
    !addresses.length ||
    addresses.some((address) => isPrivateAddress(address))
  ) {
    throw new Error("Links to private network hosts are not supported.");
  }
}

async function resolveHostAddresses(hostname: string) {
  // `dns.lookup` is not implemented by the Workers Node compatibility layer.
  // Resolve both address families explicitly so the SSRF guard behaves the
  // same in local Node development and in the deployed Worker.
  const results = await Promise.allSettled([
    resolve4(hostname),
    resolve6(hostname),
  ]);
  const addresses = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (!addresses.length) throw new Error("Could not resolve the link host.");
  return addresses;
}

function isPrivateAddress(address: string) {
  if (address.includes(":")) {
    const normalized = address.toLowerCase();
    return (
      normalized === ":" + ":1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.") ||
      /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized)
    );
  }
  const octets = address.split(".").map(Number);
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
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
      .replace(
        /<(script|style|nav|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi,
        " ",
      )
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function metaContent(html: string, name: string) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const key = tag
      .match(/(?:name|property)=["']([^"']+)["']/i)?.[1]
      ?.toLowerCase();
    if (key !== name.toLowerCase()) continue;
    return tag.match(/content=["']([^"']+)["']/i)?.[1];
  }
  return undefined;
}

async function extractImageText(
  image: string,
  mimeType: string | undefined,
  provider: AiProvider,
) {
  if (process.env.OCR_ENDPOINT) {
    const response = await fetch(process.env.OCR_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.OCR_API_KEY
          ? { authorization: `Bearer ${process.env.OCR_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({ image, mimeType }),
    });
    const payload = (await response.json()) as { text?: string };
    if (payload.text?.trim()) return payload.text.trim();
  }
  const result = await provider.generateFromImage(
    "Transcribe all visible text exactly. Preserve names, dates, numbers, captions, and source labels. Do not infer text that is not visible.",
    { data: image, mimeType },
    z.object({ text: z.string().min(1) }),
  );
  return result.text;
}

async function findReverseImageSearch(image: string, mimeType?: string) {
  if (/^https?:\/\//i.test(image)) {
    return `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(image)}`;
  }
  const endpoint = process.env.REVERSE_IMAGE_SEARCH_ENDPOINT;
  if (!endpoint) return undefined;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.REVERSE_IMAGE_SEARCH_API_KEY
          ? {
              authorization: `Bearer ${process.env.REVERSE_IMAGE_SEARCH_API_KEY}`,
            }
          : {}),
      },
      body: JSON.stringify({ image, mimeType }),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { searchUrl?: unknown };
    return typeof payload.searchUrl === "string"
      ? payload.searchUrl
      : undefined;
  } catch {
    return undefined;
  }
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
