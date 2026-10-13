export const MAX_TEXT_CHARACTERS = 50_000;
export const MAX_URL_CHARACTERS = 2_048;
export const MAX_IMAGE_BYTES = 5_000_000;

/** Below this many characters left, the margin starts counting down. */
const NEAR_LIMIT = 5_000;

export type Reading =
  | { kind: "empty" }
  | { kind: "link"; host: string; path: string; tooLong: boolean }
  | {
      kind: "claim" | "passage" | "article";
      words: number;
      sentences: number;
      paragraphs: number;
      remaining: number;
      nearLimit: boolean;
      tooLong: boolean;
      containsLink: boolean;
    };

/**
 * Describes a draft the way the server will treat it, so the composer can say
 * what happens next before anything is sent.
 */
export function readSubmission(draft: string): Reading {
  const value = draft.trim();
  if (!value) return { kind: "empty" };

  const url = parseHttpUrl(value);
  if (url) {
    const path = `${url.pathname === "/" ? "" : url.pathname}${url.search}`;
    return {
      kind: "link",
      host: url.hostname.replace(/^www\./, ""),
      path,
      tooLong: value.length > MAX_URL_CHARACTERS,
    };
  }

  const words = value.split(/\s+/).length;
  const paragraphs = value.split(/\n\s*\n/).filter((part) => part.trim()).length;
  const sentences = countSentences(value);
  const remaining = MAX_TEXT_CHARACTERS - value.length;
  const kind =
    paragraphs > 1 || words > 120 ? "article" : sentences > 1 || words > 40 ? "passage" : "claim";

  return {
    kind,
    words,
    sentences,
    paragraphs,
    remaining,
    nearLimit: remaining < NEAR_LIMIT,
    tooLong: remaining < 0,
    containsLink: /\bhttps?:\/\/\S/i.test(value),
  };
}

export function isHttpUrl(value: string) {
  return parseHttpUrl(value) !== null;
}

function parseHttpUrl(value: string) {
  if (/\s/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function countSentences(value: string) {
  // Decimal points, initials, and common abbreviations are not sentence ends.
  const ends = value
    .replace(/\b(?:[A-Z]|Mr|Mrs|Ms|Dr|St|vs|etc|e\.g|i\.e|U\.S|No)\./g, "")
    .replace(/\d\.\d/g, "")
    .match(/[.!?]+(?=\s|["'”’)\]]*(?:\s|$))/g);
  return Math.max(1, ends?.length ?? 0);
}

export function formatBytes(bytes: number) {
  if (bytes < 1_000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function formatCount(value: number, singular: string, plural = `${singular}s`) {
  return `${value.toLocaleString("en-US")} ${value === 1 ? singular : plural}`;
}
