import { z } from "zod";
import type { AiProvider } from "../provider.js";
import type { NormalizedInput } from "./types.js";
export type RawAnalysisInput = {
  text?: string;
  url?: string;
  /** Browser extensions can provide already-readable page text plus its source. */
  sourceUrl?: string;
  image?: string;
  imageMimeType?: string;
};
export async function normalizeInput(input: RawAnalysisInput, provider: AiProvider): Promise<NormalizedInput> {
  if (input.url) return normalizeUrl(input.url);
  if (input.image) { const text = await extractImageText(input.image, input.imageMimeType, provider); return { inputType: "image", rawInput: input.image, text, imageMetadata: { mimeType: input.imageMimeType, reverseSearchUrl: input.image.startsWith("http") ? `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(input.image)}` : undefined } }; }
  const text = input.text?.trim(); if (!text) throw new Error("Provide non-empty text, a URL, or an image URL/data URI.");
  // The UI has separate modes, but pasted links should still be analyzed as links.
  // Otherwise a URL reaches the LLM as if it were article text and produces no claims.
  if (isHttpUrl(text)) return normalizeUrl(text);
  const sourceUrl = input.sourceUrl && isHttpUrl(input.sourceUrl) ? input.sourceUrl : undefined;
  return {
    inputType: "text",
    rawInput: sourceUrl ?? text,
    text,
    sourceUrl,
    sourceDomain: sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, "") : undefined,
  };
}
async function normalizeUrl(value: string): Promise<NormalizedInput> {
  const url = new URL(value); if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP(S) links are supported.");
  const response = await fetch(url, { headers: { "user-agent": "Tracera/1.0 (+news verification)" }, redirect: "follow", signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error(`Could not retrieve link (HTTP ${response.status}).`);
  const html = await response.text(); const meta = (name: string) => html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)`, "i"))?.[1];
  const body = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const text = decode(body.replace(/<(script|style|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 50000); if (text.length < 40) throw new Error("The link did not contain enough readable article text.");
  return { inputType: "link", rawInput: value, text, sourceUrl: response.url, sourceDomain: new URL(response.url).hostname.replace(/^www\./, ""), publishedAt: meta("article:published_time") ?? meta("datePublished"), author: meta("author") };
}
async function extractImageText(image: string, mimeType: string | undefined, provider: AiProvider) {
  if (process.env.OCR_ENDPOINT) { const response = await fetch(process.env.OCR_ENDPOINT, { method: "POST", headers: { "content-type": "application/json", ...(process.env.OCR_API_KEY ? { authorization: `Bearer ${process.env.OCR_API_KEY}` } : {}) }, body: JSON.stringify({ image, mimeType }) }); const payload = await response.json() as { text?: string }; if (payload.text?.trim()) return payload.text.trim(); }
  const result = await provider.generate(`Extract all visible news text from this image reference. Image: ${image.slice(0, 8000)}`, z.object({ text: z.string().min(1) })); return result.text;
}
function decode(value: string) { return value.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol);
  } catch {
    return false;
  }
}
