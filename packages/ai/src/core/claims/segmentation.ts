import type { DocumentSnapshot, Locator, Span } from "@repo/contracts/core-v2";

/** Deterministic scope checks are English-lexical, so only English is validated. */
export const SUPPORTED_CLAIM_LANGUAGES = ["en"] as const;

export type SegmentHandling = "extract" | "user_caption" | "unsupported_language";

export interface InventorySegment {
  id: string;
  documentId: string;
  documentIndex: number;
  index: number;
  blockIndex: number;
  span: Span;
  text: string;
  locatorKind: Locator["kind"] | null;
  transcriptionUncertain: boolean;
  substantive: boolean;
  handling: SegmentHandling;
}

export interface InventoryBlock {
  index: number;
  span: Span;
  segmentIds: string[];
}

export interface SegmentedDocument {
  snapshot: DocumentSnapshot;
  documentIndex: number;
  segments: InventorySegment[];
  blocks: InventoryBlock[];
  language: "supported" | "unsupported";
}

export interface ExtractionChunk {
  documentId: string;
  index: number;
  ownedSegmentIds: string[];
  contextSegmentIds: string[];
}

const ABBREVIATION =
  /(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|Gen|Gov|Sen|Rep|Rev|Capt|Lt|Col|Sgt|No|Nos|vs|approx|est|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|e\.g|i\.e|[A-Z])\.$|(?:[A-Z]\.){2,}$/;

export const ENGLISH_FUNCTION_WORDS = new Set(
  "a an and are as at be been but by for from had has have he her his into is it its of on or our said says she that the their them there these they this to was were which who will with would".split(
    " ",
  ),
);

/** Common function words of other Latin-script languages, excluding English homographs. */
const OTHER_LATIN_FUNCTION_WORDS = new Set(
  "el los las del al que por para con una uno es y en su sus pero como durante le les des du et est dans pour avec qui sur pas au aux der das und ist nicht mit von ein eine zu auf für dem ich wir o os um não com em do da uma il gli che di della non sono".split(
    " ",
  ),
);

export function segmentDocument(
  snapshot: DocumentSnapshot,
  documentIndex: number,
  maxSegmentCharacters: number,
): SegmentedDocument {
  const text = snapshot.normalizedText;
  const segments: InventorySegment[] = [];
  const blocks: InventoryBlock[] = [];
  const blockPattern = /[^\n]+(?:\n(?!\n)[^\n]*)*/g;
  for (const match of text.matchAll(blockPattern)) {
    const blockStart = match.index;
    const blockText = match[0];
    const trimmed = trimSpan(text, blockStart, blockStart + blockText.length);
    if (!trimmed) continue;
    const blockIndex = blocks.length;
    const block: InventoryBlock = { index: blockIndex, span: trimmed, segmentIds: [] };
    blocks.push(block);
    const tableBlock = smallestLocator(snapshot.locators, trimmed)?.kind === "table";
    for (const span of sentenceSpans(text, trimmed, tableBlock, maxSegmentCharacters)) {
      const locator = smallestLocator(snapshot.locators, span);
      const segmentText = text.slice(span.start, span.end);
      const segment: InventorySegment = {
        id: `d${documentIndex}s${segments.length}`,
        documentId: snapshot.id,
        documentIndex,
        index: segments.length,
        blockIndex,
        span,
        text: segmentText,
        locatorKind: locator?.kind ?? null,
        transcriptionUncertain: snapshot.locators.some(
          (candidate) =>
            candidate.transcriptionUncertain &&
            candidate.span.start < span.end &&
            span.start < candidate.span.end,
        ),
        substantive: /[\p{L}\p{N}]/u.test(segmentText),
        handling: locator?.kind === "user_caption" ? "user_caption" : "extract",
      };
      segments.push(segment);
      block.segmentIds.push(segment.id);
    }
  }

  const candidates = segments.filter(
    (segment) => segment.substantive && segment.handling === "extract",
  );
  const verdicts = new Map(
    candidates.map((segment) => [segment.id, languageVerdict(segment.text)]),
  );
  const declared = snapshot.language?.toLowerCase().split(/[-_]/, 1)[0] ?? null;
  const observed = [...verdicts.values()];
  const documentVerdict =
    declared !== null
      ? (SUPPORTED_CLAIM_LANGUAGES as readonly string[]).includes(declared)
        ? "supported"
        : "unsupported"
      : observed.includes("supported") || !observed.includes("unsupported")
        ? "supported"
        : "unsupported";

  for (const segment of candidates) {
    const verdict = verdicts.get(segment.id);
    if (
      verdict === "unsupported" ||
      (verdict === "undetermined" && documentVerdict !== "supported")
    )
      segment.handling = "unsupported_language";
  }
  const extractable = segments.some(
    (segment) => segment.substantive && segment.handling === "extract",
  );
  const anyUnsupported = segments.some((segment) => segment.handling === "unsupported_language");
  return {
    snapshot,
    documentIndex,
    segments,
    blocks,
    language:
      documentVerdict === "unsupported" || (!extractable && anyUnsupported)
        ? "unsupported"
        : "supported",
  };
}

/**
 * Paragraph-aware chunks. Each chunk owns whole blocks up to the size cap and
 * repeats trailing blocks of its predecessor as read-only context, so a claim
 * whose referent or second half lies across a boundary can still be cited.
 */
export function buildChunks(
  document: SegmentedDocument,
  maxChunkCharacters: number,
  overlapCharacters: number,
): ExtractionChunk[] {
  const segmentsById = new Map(document.segments.map((segment) => [segment.id, segment]));
  const units: string[][] = [];
  for (const block of document.blocks) {
    const eligible = block.segmentIds.filter((id) => {
      const segment = segmentsById.get(id)!;
      return segment.substantive && segment.handling === "extract";
    });
    let current: string[] = [];
    let size = 0;
    for (const id of eligible) {
      const length = segmentsById.get(id)!.text.length;
      if (current.length > 0 && size + length > maxChunkCharacters) {
        units.push(current);
        current = [];
        size = 0;
      }
      current.push(id);
      size += length;
    }
    if (current.length > 0) units.push(current);
  }

  const unitLength = (unit: string[]) =>
    unit.reduce((sum, id) => sum + segmentsById.get(id)!.text.length, 0);
  const chunks: ExtractionChunk[] = [];
  let previousOwnedUnits: string[][] = [];
  for (let index = 0; index < units.length;) {
    const owned: string[][] = [];
    let size = 0;
    while (
      index < units.length &&
      (owned.length === 0 || size + unitLength(units[index]!) <= maxChunkCharacters)
    ) {
      size += unitLength(units[index]!);
      owned.push(units[index]!);
      index += 1;
    }
    const context: string[][] = [];
    let contextSize = 0;
    for (let back = previousOwnedUnits.length - 1; back >= 0; back -= 1) {
      const length = unitLength(previousOwnedUnits[back]!);
      if (contextSize + length > overlapCharacters) break;
      context.unshift(previousOwnedUnits[back]!);
      contextSize += length;
    }
    chunks.push({
      documentId: document.snapshot.id,
      index: chunks.length,
      ownedSegmentIds: owned.flat(),
      contextSegmentIds: context.flat(),
    });
    previousOwnedUnits = owned;
  }
  return chunks;
}

function sentenceSpans(
  text: string,
  block: Span,
  tableBlock: boolean,
  maxSegmentCharacters: number,
): Span[] {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const raw: Span[] = [];
  for (const part of segmenter.segment(text.slice(block.start, block.end))) {
    const span = trimSpan(
      text,
      block.start + part.index,
      block.start + part.index + part.segment.length,
    );
    if (span) raw.push(span);
  }
  const merged: Span[] = [];
  for (const span of raw) {
    const previous = merged.at(-1);
    if (previous && shouldMerge(text, previous, span, tableBlock)) {
      previous.end = span.end;
    } else {
      merged.push({ ...span });
    }
  }
  return merged.flatMap((span) => splitOversized(text, span, maxSegmentCharacters));
}

function shouldMerge(text: string, previous: Span, next: Span, tableBlock: boolean) {
  const between = text.slice(previous.end, next.start);
  if (between.includes("\n") && (tableBlock || !/^\p{Ll}/u.test(text.slice(next.start)))) {
    return false;
  }
  const previousText = text.slice(previous.start, previous.end);
  return ABBREVIATION.test(previousText) || /^\p{Ll}/u.test(text.slice(next.start, next.end));
}

function splitOversized(text: string, span: Span, max: number): Span[] {
  const pieces: Span[] = [];
  let start = span.start;
  while (span.end - start > max) {
    let end = start + max;
    const window = text.slice(start, end);
    const breakAt = window.search(/\s\S*$/);
    if (breakAt > 0) end = start + breakAt;
    if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
    const piece = trimSpan(text, start, end);
    if (piece) pieces.push(piece);
    start = end;
  }
  const rest = trimSpan(text, start, span.end);
  if (rest) pieces.push(rest);
  return pieces;
}

function trimSpan(text: string, start: number, end: number): Span | null {
  while (start < end && /\s/.test(text[start]!)) start += 1;
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
  return start < end ? { start, end } : null;
}

function smallestLocator(locators: Locator[], span: Span): Locator | null {
  let best: Locator | null = null;
  for (const locator of locators) {
    if (locator.span.start > span.start || locator.span.end < span.end) continue;
    if (!best || locator.span.end - locator.span.start < best.span.end - best.span.start) {
      best = locator;
    }
  }
  return best;
}

function languageVerdict(text: string): "supported" | "unsupported" | "undetermined" {
  const letters = [...text.matchAll(/\p{L}/gu)].length;
  if (letters === 0) return "undetermined";
  const latin = [...text.matchAll(/\p{Script=Latin}/gu)].length;
  if (latin * 2 < letters) return "unsupported";
  const words = text.toLowerCase().match(/\p{Script=Latin}+/gu) ?? [];
  const english = words.filter((word) => ENGLISH_FUNCTION_WORDS.has(word)).length;
  const other = words.filter((word) => OTHER_LATIN_FUNCTION_WORDS.has(word)).length;
  if (other >= 2 && other > english) return "unsupported";
  return english > 0 ? "supported" : "undetermined";
}
