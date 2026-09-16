import { createHash } from "node:crypto";
import {
  documentSnapshotSchema,
  type CoreIssue,
  type DocumentSnapshot,
  type StageMetrics,
  type StageResult,
} from "@repo/contracts/core-v2";
import { safeFetch, type SafeFetchOptions } from "../../safe-fetch.js";
import type { RawBlobStore } from "../storage.js";
import { extractStructuredHtml } from "./html.js";
import type {
  ContentCredentialsPort,
  ImageAcquisitionRequest,
  IngestionDocumentAcquisitionPort,
  OcrPort,
  ReaderFallbackPort,
  ReverseImageRetrievalPort,
} from "./types.js";

const DEFAULT_CHARACTER_LIMIT = 200_000;
const DEFAULT_TEXT_BYTE_LIMIT = 5_000_000;
const TEXT_CHUNK_SIZE = 16_384;
const SUPPORTED_IMAGES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface DocumentAcquisitionOptions {
  now: () => string;
  monotonicMs?: () => number;
  characterLimit?: number;
  textByteLimit?: number;
  rawBlobStore?: RawBlobStore;
  readerFallback?: ReaderFallbackPort;
  ocr?: OcrPort;
  reverseImage?: ReverseImageRetrievalPort;
  contentCredentials?: ContentCredentialsPort;
  safeFetchOptions?: SafeFetchOptions;
}

export function createDocumentAcquisitionPort(
  options: DocumentAcquisitionOptions,
): IngestionDocumentAcquisitionPort {
  const characterLimit = options.characterLimit ?? DEFAULT_CHARACTER_LIMIT;
  const textByteLimit = options.textByteLimit ?? DEFAULT_TEXT_BYTE_LIMIT;
  const monotonicMs = options.monotonicMs ?? (() => performance.now());

  return {
    async acquire(request) {
      const startedAt = options.now();
      const startedMs = monotonicMs();
      request.signal.throwIfAborted();
      try {
        const response = await safeFetch(
          request.url,
          {
            headers: { accept: "text/html,text/plain,image/*;q=0.8" },
            redirect: "follow",
            signal: request.signal,
          },
          options.safeFetchOptions,
        );
        const maxBytes = Math.min(request.maxBytes, textByteLimit);
        const read = await readBounded(response, maxBytes, request.signal);
        const mimeType = contentType(response.headers.get("content-type"));
        const finalUrl = response.url || request.url;
        if (!response.ok) {
          return unavailableFromBytes({
            url: request.url,
            finalUrl,
            role: request.role,
            mimeType,
            bytes: read.bytes,
            maxBytes,
            issue:
              response.status === 401 || response.status === 403 || response.status === 429
                ? issue(
                    "blocked_page",
                    "The original returned an access or anti-bot response.",
                    request.url,
                  )
                : issue(
                    "content_unavailable",
                    `The original returned HTTP ${response.status}.`,
                    request.url,
                  ),
            extractionStatus:
              response.status === 401 || response.status === 403 || response.status === 429
                ? "blocked"
                : "content_unavailable",
            options,
            characterLimit,
            rawTruncated: read.truncated,
            signal: request.signal,
            startedAt,
            startedMs,
            monotonicMs,
          });
        }
        if (mimeType && SUPPORTED_IMAGES.has(mimeType)) {
          return acquireImageBytes(
            {
              bytes: read.bytes,
              originalUrl: request.url,
              finalUrl,
              mimeType,
              caption: null,
              role: request.role,
              maxBytes,
              responseTruncated: read.truncated,
              signal: request.signal,
            },
            options,
            characterLimit,
            startedAt,
            startedMs,
            monotonicMs,
            1,
          );
        }
        if (
          mimeType !== "text/html" &&
          mimeType !== "application/xhtml+xml" &&
          mimeType !== "text/plain"
        ) {
          return unavailableFromBytes({
            url: request.url,
            finalUrl,
            role: request.role,
            mimeType,
            bytes: read.bytes,
            maxBytes,
            issue: issue(
              "unsupported_format",
              `Unsupported response MIME type: ${mimeType ?? "unknown"}.`,
              request.url,
            ),
            extractionStatus: "unsupported_format",
            options,
            characterLimit,
            rawTruncated: read.truncated,
            signal: request.signal,
            startedAt,
            startedMs,
            monotonicMs,
          });
        }
        const decoded = decodeText(read.bytes, response.headers.get("content-type"));
        if (mimeType === "text/plain") {
          return snapshotResult(
            await textSnapshot({
              text: decoded,
              role: request.role,
              originalUrl: request.url,
              finalUrl,
              mimeType,
              method: "plain_text",
              rawBytes: read.bytes,
              rawTruncated: read.truncated,
              byteLimit: maxBytes,
              characterLimit,
              options,
              signal: request.signal,
            }),
            read.truncated
              ? [issue("truncation", "The response exceeded an acquisition limit.", request.url)]
              : [],
            read.truncated ? "partial" : "complete",
            metrics(options.now, startedAt, startedMs, monotonicMs, 1),
          );
        }
        return acquireHtml({
          html: decoded,
          originalUrl: request.url,
          finalUrl,
          role: request.role,
          mimeType: mimeType ?? "text/html",
          rawBytes: read.bytes,
          rawTruncated: read.truncated,
          byteLimit: maxBytes,
          characterLimit,
          signal: request.signal,
          options,
          startedAt,
          startedMs,
          monotonicMs,
          externalRequests: 1,
        });
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason ?? error;
        const snapshot = await unavailableSnapshot(request.url, request.role, options.now());
        return snapshotResult(
          snapshot,
          [issue("content_unavailable", safeMessage(error), request.url)],
          "partial",
          metrics(options.now, startedAt, startedMs, monotonicMs, 1),
        );
      }
    },

    async acquireFromText(request) {
      const startedAt = options.now();
      const startedMs = monotonicMs();
      request.signal.throwIfAborted();
      const fullBytes = new TextEncoder().encode(request.text.replace(/\r\n?/g, "\n"));
      const rawTruncated = fullBytes.byteLength > textByteLimit;
      const bytes = rawTruncated ? fullBytes.subarray(0, textByteLimit) : fullBytes;
      const boundedText = decodeText(bytes, "text/plain; charset=utf-8");
      if (!boundedText.trim()) {
        const snapshot = await buildSnapshot({
          normalizedText: "",
          rawBytes: bytes,
          originalUrl: null,
          finalUrl: null,
          canonicalUrl: null,
          acquiredAt: options.now(),
          mimeType: "text/plain",
          language: null,
          role: request.role,
          extractionStatus: "content_unavailable",
          extractionMethod: "user_supplied",
          byteLimit: textByteLimit,
          characterLimit,
          truncated: rawTruncated,
          locators: [],
          timestampAssertions: [],
          discoveryHints: [],
          options,
          signal: request.signal,
        });
        return snapshotResult(
          snapshot,
          [issue("ambiguous_input", "Provided text contains no readable content.", null)],
          "partial",
          metrics(options.now, startedAt, startedMs, monotonicMs, 0),
        );
      }
      const snapshot = await textSnapshot({
        text: boundedText,
        role: request.role,
        originalUrl: null,
        finalUrl: null,
        mimeType: "text/plain",
        method: "user_supplied",
        rawBytes: bytes,
        rawTruncated,
        byteLimit: textByteLimit,
        characterLimit,
        options,
        signal: request.signal,
      });
      const truncated = snapshot.limits.truncated;
      return snapshotResult(
        snapshot,
        truncated
          ? [issue("truncation", "The provided text exceeded the character limit.", null)]
          : [],
        truncated ? "partial" : "complete",
        metrics(options.now, startedAt, startedMs, monotonicMs, 0),
      );
    },

    async acquireImage(request) {
      const startedAt = options.now();
      const startedMs = monotonicMs();
      request.signal.throwIfAborted();
      try {
        const source = await imageSource(request, options.safeFetchOptions);
        return acquireImageBytes(
          {
            ...source,
            role: request.role,
            caption: request.caption,
            maxBytes: request.maxBytes,
            signal: request.signal,
          },
          options,
          characterLimit,
          startedAt,
          startedMs,
          monotonicMs,
          source.externalRequests,
        );
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason ?? error;
        const url = /^https?:\/\//i.test(request.data) ? request.data : null;
        const snapshot = await unavailableSnapshot(
          url,
          request.role,
          options.now(),
          request.caption,
        );
        return snapshotResult(
          snapshot,
          [issue("content_unavailable", safeMessage(error), url)],
          "partial",
          metrics(options.now, startedAt, startedMs, monotonicMs, url ? 1 : 0),
        );
      }
    },
  };
}

async function acquireHtml(input: {
  html: string;
  originalUrl: string;
  finalUrl: string;
  role: DocumentSnapshot["role"];
  mimeType: string;
  rawBytes: Uint8Array;
  rawTruncated: boolean;
  byteLimit: number;
  characterLimit: number;
  signal: AbortSignal;
  options: DocumentAcquisitionOptions;
  startedAt: string;
  startedMs: number;
  monotonicMs: () => number;
  externalRequests: number;
}) {
  const extracted = extractStructuredHtml(input.html, input.finalUrl);
  if (extracted.blocked) {
    return unavailableFromBytes({
      url: input.originalUrl,
      finalUrl: input.finalUrl,
      role: input.role,
      mimeType: input.mimeType,
      bytes: input.rawBytes,
      maxBytes: input.byteLimit,
      issue: issue(
        "blocked_page",
        "The HTTP 200 response is an access, error, or anti-bot page.",
        input.originalUrl,
      ),
      extractionStatus: "blocked",
      options: input.options,
      characterLimit: input.characterLimit,
      rawTruncated: input.rawTruncated,
      signal: input.signal,
      startedAt: input.startedAt,
      startedMs: input.startedMs,
      monotonicMs: input.monotonicMs,
    });
  }

  let externalRequests = input.externalRequests;
  if (!extracted.normalizedText && input.options.readerFallback) {
    const identity = `${input.options.readerFallback.provider}@${input.options.readerFallback.version}`;
    externalRequests += 1;
    try {
      const fallback = await input.options.readerFallback.extract({
        html: input.html,
        url: input.finalUrl,
        signal: input.signal,
      });
      input.signal.throwIfAborted();
      if (fallback?.text.trim()) {
        const snapshot = await textSnapshot({
          text: fallback.text,
          role: input.role,
          originalUrl: input.originalUrl,
          finalUrl: input.finalUrl,
          mimeType: input.mimeType,
          method: "reader_fallback",
          rawBytes: input.rawBytes,
          rawTruncated: input.rawTruncated,
          byteLimit: input.byteLimit,
          characterLimit: input.characterLimit,
          options: input.options,
          signal: input.signal,
          locatorPrefix: `/reader/${encodeURIComponent(identity)}`,
        });
        const limitations = input.options.readerFallback.limitations.join("; ");
        return snapshotResult(
          snapshot,
          [
            issue(
              "ambiguous_input",
              `Reader fallback ${identity} was used. Limitations: ${limitations}`,
              input.originalUrl,
            ),
          ],
          "partial",
          metrics(
            input.options.now,
            input.startedAt,
            input.startedMs,
            input.monotonicMs,
            externalRequests,
          ),
        );
      }
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error;
      return unavailableFromBytes({
        url: input.originalUrl,
        finalUrl: input.finalUrl,
        role: input.role,
        mimeType: input.mimeType,
        bytes: input.rawBytes,
        maxBytes: input.byteLimit,
        issue: issue(
          "provider_failure",
          `Reader fallback ${identity} failed: ${safeMessage(error)}`,
          input.originalUrl,
        ),
        extractionStatus: "content_unavailable",
        options: input.options,
        characterLimit: input.characterLimit,
        rawTruncated: input.rawTruncated,
        signal: input.signal,
        startedAt: input.startedAt,
        startedMs: input.startedMs,
        monotonicMs: input.monotonicMs,
        externalRequests,
      });
    }
  }

  if (!extracted.normalizedText) {
    return unavailableFromBytes({
      url: input.originalUrl,
      finalUrl: input.finalUrl,
      role: input.role,
      mimeType: input.mimeType,
      bytes: input.rawBytes,
      maxBytes: input.byteLimit,
      issue: issue(
        "content_unavailable",
        "No readable article structure was found.",
        input.originalUrl,
      ),
      extractionStatus: "content_unavailable",
      options: input.options,
      characterLimit: input.characterLimit,
      rawTruncated: input.rawTruncated,
      signal: input.signal,
      startedAt: input.startedAt,
      startedMs: input.startedMs,
      monotonicMs: input.monotonicMs,
      externalRequests: input.externalRequests,
    });
  }

  const retained = truncateText(extracted.normalizedText, input.characterLimit);
  const locators = cropLocators(extracted.locators, retained.text.length);
  const base = await buildSnapshot({
    normalizedText: retained.text,
    rawBytes: input.rawBytes,
    originalUrl: input.originalUrl,
    finalUrl: input.finalUrl,
    canonicalUrl: extracted.canonicalUrl,
    acquiredAt: input.options.now(),
    mimeType: input.mimeType,
    language: extracted.language,
    role: input.role,
    extractionStatus: input.rawTruncated || retained.truncated ? "partial" : "complete",
    extractionMethod: "structured_html",
    byteLimit: input.byteLimit,
    characterLimit: input.characterLimit,
    truncated: input.rawTruncated || retained.truncated,
    locators,
    timestampAssertions: extracted.timestamps.filter(
      (timestamp) =>
        timestamp.locatorId === null || locators.some(({ id }) => id === timestamp.locatorId),
    ),
    discoveryHints: [],
    options: input.options,
    signal: input.signal,
  });
  const truncated = base.limits.truncated;
  return snapshotResult(
    base,
    truncated
      ? [issue("truncation", "The article exceeded an acquisition limit.", input.originalUrl)]
      : [],
    truncated ? "partial" : "complete",
    metrics(
      input.options.now,
      input.startedAt,
      input.startedMs,
      input.monotonicMs,
      externalRequests,
    ),
  );
}

async function acquireImageBytes(
  input: {
    bytes: Uint8Array;
    originalUrl: string | null;
    finalUrl: string | null;
    mimeType: string;
    caption: string | null;
    role: DocumentSnapshot["role"];
    maxBytes: number;
    responseTruncated: boolean;
    signal: AbortSignal;
  },
  options: DocumentAcquisitionOptions,
  characterLimit: number,
  startedAt: string,
  startedMs: number,
  monotonicMs: () => number,
  externalRequests: number,
): Promise<StageResult<{ snapshot: DocumentSnapshot }>> {
  if (!SUPPORTED_IMAGES.has(input.mimeType)) {
    return unusableImageResult(
      input,
      options,
      characterLimit,
      issue(
        "unsupported_format",
        `Unsupported image MIME type: ${input.mimeType}.`,
        input.originalUrl,
      ),
      false,
      startedAt,
      startedMs,
      monotonicMs,
      externalRequests,
    );
  }
  if (!matchesImageSignature(input.bytes, input.mimeType)) {
    return unusableImageResult(
      input,
      options,
      characterLimit,
      issue(
        "unsupported_format",
        "The image bytes do not match the declared MIME type.",
        input.originalUrl,
      ),
      false,
      startedAt,
      startedMs,
      monotonicMs,
      externalRequests,
    );
  }
  if (input.responseTruncated) {
    return unusableImageResult(
      input,
      options,
      characterLimit,
      issue(
        "truncation",
        "The image exceeded the byte limit and was not sent to OCR.",
        input.originalUrl,
      ),
      true,
      startedAt,
      startedMs,
      monotonicMs,
      externalRequests,
    );
  }
  const issues: CoreIssue[] = [];
  const parts: Array<{
    text: string;
    kind: DocumentSnapshot["locators"][number]["kind"];
    path: string;
    boundingBox: DocumentSnapshot["locators"][number]["boundingBox"];
    uncertain: boolean;
  }> = [];
  if (options.ocr) {
    try {
      externalRequests += 1;
      const result = await options.ocr.recognize({
        bytes: input.bytes,
        mimeType: input.mimeType,
        signal: input.signal,
      });
      result.regions.forEach((region, index) => {
        if (!region.text.trim()) return;
        parts.push({
          text: region.text.replace(/\r\n?/g, "\n").trim(),
          kind: "ocr_text",
          path: `/ocr/${encodeURIComponent(options.ocr!.provider)}@${encodeURIComponent(options.ocr!.modelId)}/region[${index + 1}]`,
          boundingBox: region.boundingBox,
          uncertain: region.transcriptionUncertain,
        });
      });
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error;
      issues.push(
        issue(
          "provider_failure",
          `OCR provider ${options.ocr.provider} failed: ${safeMessage(error)}`,
          input.originalUrl,
        ),
      );
    }
  } else {
    issues.push(
      issue(
        "capability_unavailable",
        "OCR capability is unavailable; visible image text was not inferred.",
        input.originalUrl,
      ),
    );
  }
  if (input.caption?.trim()) {
    parts.push({
      text: input.caption.trim(),
      kind: "user_caption",
      path: "/user-caption[1]",
      boundingBox: null,
      uncertain: false,
    });
  }
  if (options.reverseImage) {
    try {
      externalRequests += 1;
      const reverse = await options.reverseImage.search({
        bytes: input.bytes,
        mimeType: input.mimeType,
        signal: input.signal,
      });
      if (reverse.status !== "performed") {
        issues.push(
          issue(
            "capability_unavailable",
            `Reverse-image connector ${options.reverseImage.connector} was unavailable; visual provenance is unverified.`,
            input.originalUrl,
          ),
        );
      }
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error;
      issues.push(
        issue(
          "provider_failure",
          `Reverse-image connector ${options.reverseImage.connector} failed; visual provenance is unverified: ${safeMessage(error)}`,
          input.originalUrl,
        ),
      );
    }
  } else {
    issues.push(
      issue(
        "capability_unavailable",
        "No validated reverse-image connector is configured; visual provenance is unverified.",
        input.originalUrl,
      ),
    );
  }
  if (options.contentCredentials) {
    try {
      externalRequests += 1;
      const credentials = await options.contentCredentials.inspect({
        bytes: input.bytes,
        mimeType: input.mimeType,
        signal: input.signal,
      });
      if (credentials.status !== "verified") {
        issues.push(
          issue(
            "capability_unavailable",
            `Content credentials are ${credentials.status}; image authenticity is not certified.`,
            input.originalUrl,
          ),
        );
      }
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? error;
      issues.push(
        issue(
          "provider_failure",
          `Content-credentials verifier ${options.contentCredentials.verifier} failed; image authenticity is not certified: ${safeMessage(error)}`,
          input.originalUrl,
        ),
      );
    }
  } else {
    issues.push(
      issue(
        "capability_unavailable",
        "No content-credentials verifier is configured; image authenticity is not certified.",
        input.originalUrl,
      ),
    );
  }
  input.signal.throwIfAborted();

  let normalizedText = "";
  const locators: DocumentSnapshot["locators"] = [];
  for (const [index, part] of parts.entries()) {
    if (normalizedText) normalizedText += "\n\n";
    const start = normalizedText.length;
    normalizedText += part.text;
    locators.push({
      id: `loc_${index + 1}`,
      kind: part.kind,
      path: part.path,
      span: { start, end: normalizedText.length },
      boundingBox: part.boundingBox,
      transcriptionUncertain: part.uncertain,
    });
  }
  const retained = truncateText(normalizedText, characterLimit);
  const truncated = input.responseTruncated || retained.truncated;
  if (truncated)
    issues.push(
      issue(
        "truncation",
        "The image or transcription exceeded an acquisition limit.",
        input.originalUrl,
      ),
    );
  const extractionStatus =
    !options.ocr || !retained.text ? "partial" : truncated ? "partial" : "complete";
  const snapshot = await buildSnapshot({
    normalizedText: retained.text,
    rawBytes: input.bytes,
    originalUrl: input.originalUrl,
    finalUrl: input.finalUrl,
    canonicalUrl: null,
    acquiredAt: options.now(),
    mimeType: input.mimeType,
    language: null,
    role: input.role,
    extractionStatus,
    extractionMethod: options.ocr ? "ocr" : input.caption?.trim() ? "user_supplied" : "none",
    byteLimit: input.maxBytes,
    characterLimit,
    truncated,
    locators: cropLocators(locators, retained.text.length),
    timestampAssertions: [],
    discoveryHints: input.caption?.trim()
      ? [{ kind: "user_caption", text: input.caption.trim() }]
      : [],
    options,
    signal: input.signal,
  });
  return snapshotResult(
    snapshot,
    issues,
    issues.length || extractionStatus !== "complete" ? "partial" : "complete",
    metrics(options.now, startedAt, startedMs, monotonicMs, externalRequests),
  );
}

async function imageSource(request: ImageAcquisitionRequest, fetchOptions?: SafeFetchOptions) {
  if (/^https?:\/\//i.test(request.data)) {
    const response = await safeFetch(
      request.data,
      { signal: request.signal, redirect: "follow" },
      fetchOptions,
    );
    if (!response.ok) throw new Error(`The image returned HTTP ${response.status}.`);
    const mimeType = contentType(response.headers.get("content-type"));
    if (!mimeType) throw new Error("The image response did not declare a MIME type.");
    if (mimeType !== request.mimeType)
      throw new Error("The image response MIME type does not match the submitted type.");
    const read = await readBounded(response, request.maxBytes, request.signal);
    return {
      bytes: read.bytes,
      originalUrl: request.data,
      finalUrl: response.url || request.data,
      mimeType,
      responseTruncated: read.truncated,
      externalRequests: 1,
    };
  }
  const match = request.data.match(/^data:([^;,]+);base64,([a-zA-Z0-9+/=\s]+)$/s);
  if (!match) throw new Error("Image input must be a public URL or base64 data URI.");
  if (match[1] !== request.mimeType)
    throw new Error("The image data URI MIME type does not match the submitted type.");
  const decoded = Buffer.from(match[2]!.replace(/\s/g, ""), "base64");
  if (decoded.byteLength > request.maxBytes) throw new Error("The image exceeds the byte limit.");
  return {
    bytes: decoded,
    originalUrl: null,
    finalUrl: null,
    mimeType: request.mimeType,
    responseTruncated: false,
    externalRequests: 0,
  };
}

async function textSnapshot(input: {
  text: string;
  role: DocumentSnapshot["role"];
  originalUrl: string | null;
  finalUrl: string | null;
  mimeType: string;
  method: DocumentSnapshot["extractionMethod"];
  rawBytes: Uint8Array;
  rawTruncated: boolean;
  byteLimit: number;
  characterLimit: number;
  options: DocumentAcquisitionOptions;
  signal: AbortSignal;
  locatorPrefix?: string;
}) {
  const normalized = input.text.replace(/\r\n?/g, "\n");
  const retained = truncateText(normalized, input.characterLimit);
  const locators: DocumentSnapshot["locators"] = [];
  for (let start = 0, index = 1; start < retained.text.length; index += 1) {
    const end = safeChunkEnd(retained.text, start, TEXT_CHUNK_SIZE);
    locators.push({
      id: `loc_${index}`,
      kind: "paragraph",
      path: `${input.locatorPrefix ?? "/text"}/chunk[${index}]`,
      span: { start, end },
      boundingBox: null,
      transcriptionUncertain: false,
    });
    start = end;
  }
  return buildSnapshot({
    normalizedText: retained.text,
    rawBytes: input.rawBytes,
    originalUrl: input.originalUrl,
    finalUrl: input.finalUrl,
    canonicalUrl: null,
    acquiredAt: input.options.now(),
    mimeType: input.mimeType,
    language: null,
    role: input.role,
    extractionStatus: input.rawTruncated || retained.truncated ? "partial" : "complete",
    extractionMethod: input.method,
    byteLimit: input.byteLimit,
    characterLimit: input.characterLimit,
    truncated: input.rawTruncated || retained.truncated,
    locators,
    timestampAssertions: [],
    discoveryHints: [],
    options: input.options,
    signal: input.signal,
  });
}

async function unavailableFromBytes(input: {
  url: string;
  finalUrl: string;
  role: DocumentSnapshot["role"];
  mimeType: string | null;
  bytes: Uint8Array;
  maxBytes: number;
  issue: CoreIssue;
  extractionStatus: "blocked" | "content_unavailable" | "unsupported_format";
  options: DocumentAcquisitionOptions;
  characterLimit: number;
  rawTruncated: boolean;
  signal: AbortSignal;
  startedAt: string;
  startedMs: number;
  monotonicMs: () => number;
  externalRequests?: number;
}) {
  const snapshot = await buildSnapshot({
    normalizedText: "",
    rawBytes: input.bytes,
    originalUrl: input.url,
    finalUrl: input.finalUrl,
    canonicalUrl: null,
    acquiredAt: input.options.now(),
    mimeType: input.mimeType,
    language: null,
    role: input.role,
    extractionStatus: input.extractionStatus,
    extractionMethod: "none",
    byteLimit: input.maxBytes,
    characterLimit: input.characterLimit,
    truncated: input.rawTruncated,
    locators: [],
    timestampAssertions: [],
    discoveryHints: slugHint(input.url),
    options: input.options,
    signal: input.signal,
  });
  return snapshotResult(
    snapshot,
    [
      input.issue,
      ...(input.rawTruncated
        ? [issue("truncation", "The unavailable response also exceeded the byte limit.", input.url)]
        : []),
    ],
    "partial",
    metrics(
      input.options.now,
      input.startedAt,
      input.startedMs,
      input.monotonicMs,
      input.externalRequests ?? 1,
    ),
  );
}

async function unusableImageResult(
  input: {
    bytes: Uint8Array;
    originalUrl: string | null;
    finalUrl: string | null;
    mimeType: string;
    caption: string | null;
    role: DocumentSnapshot["role"];
    maxBytes: number;
    signal: AbortSignal;
  },
  options: DocumentAcquisitionOptions,
  characterLimit: number,
  failure: CoreIssue,
  truncated: boolean,
  startedAt: string,
  startedMs: number,
  monotonicMs: () => number,
  externalRequests: number,
) {
  const snapshot = await buildSnapshot({
    normalizedText: "",
    rawBytes: input.bytes,
    originalUrl: input.originalUrl,
    finalUrl: input.finalUrl,
    canonicalUrl: null,
    acquiredAt: options.now(),
    mimeType: input.mimeType,
    language: null,
    role: input.role,
    extractionStatus: truncated ? "partial" : "unsupported_format",
    extractionMethod: "none",
    byteLimit: input.maxBytes,
    characterLimit,
    truncated,
    locators: [],
    timestampAssertions: [],
    discoveryHints: input.caption?.trim()
      ? [{ kind: "user_caption", text: input.caption.trim() }]
      : [],
    options,
    signal: input.signal,
  });
  return snapshotResult(
    snapshot,
    [failure],
    "partial",
    metrics(options.now, startedAt, startedMs, monotonicMs, externalRequests),
  );
}

async function unavailableSnapshot(
  url: string | null,
  role: DocumentSnapshot["role"],
  acquiredAt: string,
  caption?: string | null,
) {
  const discoveryHints: DocumentSnapshot["discoveryHints"] = [
    ...(url ? slugHint(url) : []),
    ...(caption?.trim() ? [{ kind: "user_caption" as const, text: caption.trim() }] : []),
  ];
  const raw = {
    id: stableId({ url, role, acquiredAt: null, discoveryHints }),
    contentHash: hash(new Uint8Array()),
    rawContentHash: null,
    originalUrl: url,
    finalUrl: null,
    canonicalUrl: null,
    acquiredAt,
    mimeType: null,
    language: null,
    role,
    normalizedText: "",
    extractionStatus: "content_unavailable" as const,
    extractionMethod: "none" as const,
    limits: {
      byteLimit: DEFAULT_TEXT_BYTE_LIMIT,
      characterLimit: DEFAULT_CHARACTER_LIMIT,
      bytesRetained: 0,
      charactersRetained: 0,
      truncated: false,
    },
    locators: [],
    timestampAssertions: [],
    discoveryHints,
    blobLocator: { status: "unavailable" as const, uri: null },
  };
  return documentSnapshotSchema.parse(raw);
}

async function buildSnapshot(input: {
  normalizedText: string;
  rawBytes: Uint8Array;
  originalUrl: string | null;
  finalUrl: string | null;
  canonicalUrl: string | null;
  acquiredAt: string;
  mimeType: string | null;
  language: string | null;
  role: DocumentSnapshot["role"];
  extractionStatus: DocumentSnapshot["extractionStatus"];
  extractionMethod: DocumentSnapshot["extractionMethod"];
  byteLimit: number;
  characterLimit: number;
  truncated: boolean;
  locators: DocumentSnapshot["locators"];
  timestampAssertions: DocumentSnapshot["timestampAssertions"];
  discoveryHints: DocumentSnapshot["discoveryHints"];
  options: DocumentAcquisitionOptions;
  signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  const normalizedBytes = new TextEncoder().encode(input.normalizedText);
  const rawContentHash = hash(input.rawBytes);
  const id = stableId({
    contentHash: hash(normalizedBytes),
    rawContentHash,
    originalUrl: input.originalUrl,
    finalUrl: input.finalUrl,
    canonicalUrl: input.canonicalUrl,
    role: input.role,
    extractionMethod: input.extractionMethod,
  });
  const blobLocator = input.options.rawBlobStore
    ? await input.options.rawBlobStore.put({
        snapshotId: id,
        bytes: input.rawBytes,
        signal: input.signal,
      })
    : { status: "unavailable" as const, uri: null };
  input.signal.throwIfAborted();
  return documentSnapshotSchema.parse({
    id,
    contentHash: hash(normalizedBytes),
    rawContentHash,
    originalUrl: input.originalUrl,
    finalUrl: input.finalUrl,
    canonicalUrl: input.canonicalUrl,
    acquiredAt: input.acquiredAt,
    mimeType: input.mimeType,
    language: input.language,
    role: input.role,
    normalizedText: input.normalizedText,
    extractionStatus: input.extractionStatus,
    extractionMethod: input.extractionMethod,
    limits: {
      byteLimit: input.byteLimit,
      characterLimit: input.characterLimit,
      bytesRetained: normalizedBytes.byteLength,
      charactersRetained: input.normalizedText.length,
      truncated: input.truncated,
    },
    locators: input.locators,
    timestampAssertions: input.timestampAssertions,
    discoveryHints: input.discoveryHints,
    blobLocator,
  });
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let truncated = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      const remaining = maxBytes - retained;
      if (next.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(next.value.subarray(0, remaining));
        retained += Math.max(remaining, 0);
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(next.value);
      retained += next.value.byteLength;
      if (retained === maxBytes) {
        const extra = await reader.read();
        truncated = !extra.done;
        if (truncated) await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

function decodeText(bytes: Uint8Array, rawContentType: string | null) {
  const charset = rawContentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
  const input = isUtf8Charset(charset) ? trimIncompleteUtf8(bytes) : bytes;
  try {
    return new TextDecoder(charset).decode(input);
  } catch {
    return new TextDecoder("utf-8").decode(trimIncompleteUtf8(bytes));
  }
}

function isUtf8Charset(charset: string) {
  return ["utf-8", "utf8", "unicode-1-1-utf-8"].includes(charset.toLowerCase());
}

function trimIncompleteUtf8(bytes: Uint8Array) {
  const start = Math.max(0, bytes.length - 4);
  for (let index = bytes.length - 1; index >= start; index -= 1) {
    const byte = bytes[index]!;
    if ((byte & 0xc0) === 0x80) continue;
    const expectedLength =
      byte <= 0x7f
        ? 1
        : byte >= 0xc2 && byte <= 0xdf
          ? 2
          : byte >= 0xe0 && byte <= 0xef
            ? 3
            : byte >= 0xf0 && byte <= 0xf4
              ? 4
              : 1;
    return expectedLength > bytes.length - index ? bytes.subarray(0, index) : bytes;
  }
  return bytes;
}

function truncateText(text: string, limit: number) {
  if (text.length <= limit) return { text, truncated: false };
  let end = limit;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function safeChunkEnd(text: string, start: number, size: number) {
  let end = Math.min(text.length, start + size);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
  return end;
}

function cropLocators(locators: DocumentSnapshot["locators"], length: number) {
  return locators.flatMap((locator) => {
    const end = Math.min(locator.span.end, length);
    if (locator.span.start >= end) return [];
    return [{ ...locator, span: { start: locator.span.start, end } }];
  });
}

function slugHint(url: string): DocumentSnapshot["discoveryHints"] {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const text = decodeURIComponent(parts.at(-1) ?? "")
      .replace(/[-_]+/g, " ")
      .trim();
    return text ? [{ kind: "url_slug", text }] : [];
  } catch {
    return [];
  }
}

function contentType(value: string | null) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

function matchesImageSignature(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "image/png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (mimeType === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (mimeType === "image/gif") {
    const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 6));
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return (
      new TextDecoder("ascii").decode(bytes.subarray(0, 4)) === "RIFF" &&
      new TextDecoder("ascii").decode(bytes.subarray(8, 12)) === "WEBP"
    );
  }
  return false;
}

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function hash(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stableId(value: object) {
  return `snap_${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function issue(code: CoreIssue["code"], message: string, url: string | null): CoreIssue {
  return { code, severity: "warning", message, claimId: null, snapshotId: null, url };
}

function snapshotResult(
  snapshot: DocumentSnapshot,
  issues: CoreIssue[],
  status: "complete" | "partial",
  stageMetrics: StageMetrics,
): StageResult<{ snapshot: DocumentSnapshot }> {
  return { status, data: { snapshot }, issues, metrics: stageMetrics };
}

function metrics(
  now: () => string,
  startedAt: string,
  startedMs: number,
  monotonicMs: () => number,
  externalRequests: number,
): StageMetrics {
  return {
    startedAt,
    completedAt: now(),
    durationMs: Math.max(0, monotonicMs() - startedMs),
    externalRequests,
    inputTokens: null,
    outputTokens: null,
    costUsd: externalRequests === 0 ? 0 : null,
  };
}

function safeMessage(error: unknown) {
  return error instanceof Error ? error.message : "The original content could not be acquired.";
}

export { DEFAULT_CHARACTER_LIMIT, DEFAULT_TEXT_BYTE_LIMIT, SUPPORTED_IMAGES };
