import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  createDocumentAcquisitionPort,
  createFilesystemRawBlobStore,
  extractStructuredHtml,
  type OcrPort,
} from "../src/core/ingestion/index.js";

const NOW = "2026-09-14T00:00:00.000Z";
const publicResolver = async () => ["8.8.8.8"];

test("structured HTML preserves headings, paragraphs, captions, and numeric tables", async () => {
  const html = `<!doctype html><html lang="en"><head>
      <title>Annual report</title>
      <link rel="canonical" href="/reports/2026">
      <meta property="article:published_time" content="2026-09-12T08:30:00Z">
      </head><body><article><h1>Results</h1><p>Revenue increased.</p>
      <figure><img alt="A rising line"><figcaption>Figure 1: annual revenue</figcaption></figure>
      <table><caption>Revenue table</caption><tr><th>Year</th><th>Revenue</th></tr>
      <tr><td>2025</td><td>$12.4 million</td></tr></table></article></body></html>`;
  const extracted = extractStructuredHtml(html, "https://reports.example/source");

  assert.equal(extracted.canonicalUrl, "https://reports.example/reports/2026");
  assert.equal(extracted.language, "en");
  assert.match(extracted.normalizedText, /2025\t\$12\.4 million/);
  assert.ok(extracted.locators.some(({ kind }) => kind === "heading"));
  assert.ok(extracted.locators.some(({ kind }) => kind === "caption"));
  assert.ok(extracted.locators.some(({ kind }) => kind === "table_cell"));
  for (const locator of extracted.locators) {
    assert.ok(extracted.normalizedText.slice(locator.span.start, locator.span.end).length > 0);
  }
  assert.equal(extracted.timestamps[0]?.source, "html_meta");
});

test("an HTTP 200 anti-bot page is blocked and its raw bytes remain immutable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tracera-ingestion-"));
  const port = fixturePort(
    async () =>
      new Response(
        "<html><title>Attention Required</title><body>Verify you are human</body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
    createFilesystemRawBlobStore(directory),
  );
  const result = await port.acquire({
    url: "https://news.example/real-looking-headline",
    role: "submitted_input",
    maxBytes: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "partial");
  assert.equal(result.data?.snapshot.extractionStatus, "blocked");
  assert.equal(result.data?.snapshot.normalizedText, "");
  assert.equal(result.issues[0]?.code, "blocked_page");
  assert.equal(result.data?.snapshot.blobLocator.status, "stored");
  const bytes = await readFile(new URL(result.data!.snapshot.blobLocator.uri!));
  assert.match(bytes.toString(), /Verify you are human/);
});

test("a misleading URL slug remains only a discovery hint when content is unavailable", async () => {
  const port = fixturePort(async () => new Response("Forbidden", { status: 403 }));
  const result = await port.acquire({
    url: "https://news.example/scientists-confirm-mars-is-green",
    role: "submitted_input",
    maxBytes: 10_000,
    signal: new AbortController().signal,
  });
  const snapshot = result.data!.snapshot;

  assert.equal(result.status, "partial");
  assert.equal(snapshot.extractionStatus, "blocked");
  assert.equal(snapshot.normalizedText, "");
  assert.deepEqual(snapshot.discoveryHints, [
    { kind: "url_slug", text: "scientists confirm mars is green" },
  ]);
  assert.equal(result.issues[0]?.code, "blocked_page");
});

test("long text is explicitly truncated and retained in stable UTF-16 chunks", async () => {
  const port = createDocumentAcquisitionPort({
    now: () => NOW,
    characterLimit: 40_000,
  });
  const text = `${"a".repeat(20_000)}😀${"b".repeat(30_000)}`;
  const result = await port.acquireFromText({
    text,
    role: "submitted_input",
    signal: new AbortController().signal,
  });
  const snapshot = result.data!.snapshot;

  assert.equal(result.status, "partial");
  assert.equal(snapshot.normalizedText.length, 40_000);
  assert.equal(snapshot.limits.truncated, true);
  assert.ok(snapshot.locators.length > 2);
  assert.equal(snapshot.locators[0]?.span.start, 0);
  assert.equal(snapshot.locators.at(-1)?.span.end, snapshot.normalizedText.length);
  snapshot.locators.forEach((locator, index) => {
    if (index > 0) assert.equal(locator.span.start, snapshot.locators[index - 1]!.span.end);
  });
});

test("private redirect targets are rejected before the redirected request", async () => {
  let requests = 0;
  const port = createDocumentAcquisitionPort({
    now: () => NOW,
    safeFetchOptions: {
      resolveHostAddresses: async (hostname) =>
        hostname === "public.example" ? ["8.8.8.8"] : ["127.0.0.1"],
      fetchImplementation: async () => {
        requests += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/admin" },
        });
      },
    },
  });
  const result = await port.acquire({
    url: "https://public.example/article",
    role: "submitted_input",
    maxBytes: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(requests, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.data?.snapshot.extractionStatus, "content_unavailable");
  assert.match(result.issues[0]!.message, /private network hosts/);
});

test("OCR keeps ambiguous visible text, region boxes, and the user caption distinct", async () => {
  const ocr: OcrPort = {
    provider: "fixture-ocr",
    modelId: "fixture-ocr-1",
    async recognize() {
      return {
        regions: [
          {
            text: "Meeting on 2l May",
            boundingBox: { page: 0, frameId: null, x: 10, y: 20, width: 200, height: 30 },
            transcriptionUncertain: true,
          },
        ],
      };
    },
  };
  const port = createDocumentAcquisitionPort({ now: () => NOW, ocr });
  const result = await port.acquireImage({
    data: "data:image/png;base64,iVBORw0KGgo=",
    mimeType: "image/png",
    caption: "User says this was taken in Delhi",
    role: "submitted_input",
    maxBytes: 10_000,
    signal: new AbortController().signal,
  });
  const snapshot = result.data!.snapshot;
  const ocrLocator = snapshot.locators.find(({ kind }) => kind === "ocr_text")!;
  const captionLocator = snapshot.locators.find(({ kind }) => kind === "user_caption")!;

  assert.equal(ocrLocator.transcriptionUncertain, true);
  assert.deepEqual(ocrLocator.boundingBox, {
    page: 0,
    frameId: null,
    x: 10,
    y: 20,
    width: 200,
    height: 30,
  });
  assert.equal(
    snapshot.normalizedText.slice(ocrLocator.span.start, ocrLocator.span.end),
    "Meeting on 2l May",
  );
  assert.equal(
    snapshot.normalizedText.slice(captionLocator.span.start, captionLocator.span.end),
    "User says this was taken in Delhi",
  );
  assert.deepEqual(snapshot.discoveryHints, [
    { kind: "user_caption", text: "User says this was taken in Delhi" },
  ]);
  assert.ok(
    result.issues.some(({ message }) => message.includes("visual provenance is unverified")),
  );
  assert.ok(result.issues.some(({ message }) => message.includes("authenticity is not certified")));
});

test("unavailable original content cannot produce a complete acquisition or article text", async () => {
  const port = fixturePort(async () => {
    throw new Error("origin unavailable");
  });
  const result = await port.acquire({
    url: "https://publisher.example/full-score-claim",
    role: "submitted_input",
    maxBytes: 10_000,
    signal: new AbortController().signal,
  });

  assert.notEqual(result.status, "complete");
  assert.equal(result.data?.snapshot.extractionStatus, "content_unavailable");
  assert.equal(result.data?.snapshot.normalizedText, "");
  assert.equal(result.data?.snapshot.discoveryHints[0]?.kind, "url_slug");
});

test("unsupported formats are retained only as unavailable raw snapshots", async () => {
  const port = fixturePort(
    async () =>
      new Response("%PDF fixture", {
        headers: { "content-type": "application/pdf" },
      }),
  );
  const result = await port.acquire({
    url: "https://publisher.example/report.pdf",
    role: "submitted_input",
    maxBytes: 10_000,
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "partial");
  assert.equal(result.data?.snapshot.extractionStatus, "unsupported_format");
  assert.equal(result.data?.snapshot.normalizedText, "");
  assert.equal(result.issues[0]?.code, "unsupported_format");
});

test("reader fallback records connector identity and limitations without claiming full extraction", async () => {
  const raw = "<html><body><div id='app'></div></body></html>";
  const port = createDocumentAcquisitionPort({
    now: () => NOW,
    readerFallback: {
      provider: "fixture-reader",
      version: "2.1.0",
      limitations: ["dynamic tables are omitted"],
      async extract() {
        return { text: "Fallback article body." };
      },
    },
    safeFetchOptions: {
      resolveHostAddresses: publicResolver,
      fetchImplementation: async () =>
        new Response(raw, { headers: { "content-type": "text/html" } }),
    },
  });
  const result = await port.acquire({
    url: "https://publisher.example/dynamic-article",
    role: "submitted_input",
    maxBytes: 10_000,
    signal: new AbortController().signal,
  });
  const snapshot = result.data!.snapshot;

  assert.equal(result.status, "partial");
  assert.equal(snapshot.extractionMethod, "reader_fallback");
  assert.match(snapshot.locators[0]!.path, /fixture-reader%402\.1\.0/);
  assert.match(result.issues[0]!.message, /dynamic tables are omitted/);
  assert.equal(snapshot.rawContentHash, `sha256:${createHash("sha256").update(raw).digest("hex")}`);
  assert.equal(
    snapshot.contentHash,
    `sha256:${createHash("sha256").update("Fallback article body.").digest("hex")}`,
  );
});

function fixturePort(
  fetchImplementation: typeof fetch,
  rawBlobStore?: ReturnType<typeof createFilesystemRawBlobStore>,
) {
  return createDocumentAcquisitionPort({
    now: () => NOW,
    rawBlobStore,
    safeFetchOptions: { fetchImplementation, resolveHostAddresses: publicResolver },
  });
}
