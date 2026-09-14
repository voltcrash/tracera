import type { ClaimV2, Span, TimeInterval } from "@repo/contracts/core-v2";
import type { QuoteReference, RawClaim } from "./generation.js";
import {
  ENGLISH_FUNCTION_WORDS,
  type InventorySegment,
  type SegmentedDocument,
} from "./segmentation.js";

export interface ClaimDraft {
  localId: string;
  documentId: string;
  documentIndex: number;
  text: string;
  retrievalText: string;
  spans: Span[];
  segmentIds: string[];
  proposition: ClaimV2["proposition"];
  attribution: ClaimV2["attribution"];
  negated: boolean;
  quantities: ClaimV2["quantities"];
  time: ClaimV2["time"];
  place: string | null;
  unresolvedContext: string[];
  checkability: ClaimV2["checkability"];
  material: boolean;
  parentLocalId: string | null;
  notes: string[];
}

export type ClaimValidation =
  | { accepted: true; draft: ClaimDraft }
  | { accepted: false; reason: string };

export interface ChunkScope {
  document: SegmentedDocument;
  segmentsById: Map<string, InventorySegment>;
  chunkSegmentIds: Set<string>;
  ownedSegmentIds: Set<string>;
}

const NEGATION = /\b(?:not|no|never|none|nobody|nothing|neither|nor|cannot|without)\b|n['’]t\b/i;
const ATTRIBUTION_CUE =
  /\b(?:said|says|say|according to|claimed|claims|stated|states|told|reported|reports|alleged|alleges|announced|announces|denied|denies|insisted|argued|wrote|testified)\b/gi;
const YEAR = /\b(?:1[6-9]\d{2}|20\d{2})\b/g;
const NUMBER = /\d+(?:[.,]\d+)*/g;
const DENOMINATOR_LEAD = /^\s*(?:of|among|per|for every|out of)\s+\S/i;
const PRONOUNS = new Set(
  "he she they it this that these those him her them his hers their theirs its we us our i you".split(
    " ",
  ),
);
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

export function validateRawClaim(raw: RawClaim, scope: ChunkScope): ClaimValidation {
  const { document } = scope;
  const sourceText = document.snapshot.normalizedText;
  const spans: Span[] = [];
  const segmentIds = new Set<string>();
  let citesOwned = false;
  for (const reference of raw.sourceQuotes) {
    const located = locateQuote(reference, scope);
    if ("error" in located) return reject(`source quote rejected: ${located.error}`);
    spans.push(located.span);
    segmentIds.add(reference.segmentId);
    if (scope.ownedSegmentIds.has(reference.segmentId)) citesOwned = true;
  }
  if (!citesOwned) return reject("no source quote lies in a segment this chunk may extract");
  const orderedSpans = normalizeSpans(spans);
  if (!orderedSpans) return reject("source quotes overlap each other");
  const touched = [...segmentIds].map((id) => scope.segmentsById.get(id)!);
  const segmentText = touched.map((segment) => segment.text).join(" ");
  const spansText = orderedSpans.map((span) => sourceText.slice(span.start, span.end)).join(" ");
  const firstSegment = touched.reduce((first, segment) =>
    segment.index < first.index ? segment : first,
  );
  const windowText = localWindow(document, firstSegment, scope);

  const draft: ClaimDraft = {
    localId: raw.localId,
    documentId: document.snapshot.id,
    documentIndex: document.documentIndex,
    text: collapse(raw.text),
    retrievalText: collapse(raw.retrievalText),
    spans: orderedSpans,
    segmentIds: [...segmentIds].sort(
      (left, right) => scope.segmentsById.get(left)!.index - scope.segmentsById.get(right)!.index,
    ),
    proposition: {
      subject: collapse(raw.proposition.subject),
      predicate: collapse(raw.proposition.predicate),
      object: raw.proposition.object === null ? null : collapse(raw.proposition.object),
      qualifiers: raw.proposition.qualifiers.map(collapse),
    },
    attribution: {
      kind: raw.attribution.kind,
      attributedTo: raw.attribution.attributedTo,
      attributionSpan: null,
    },
    negated: raw.negated,
    quantities: raw.quantities,
    time: { statedText: raw.time.statedText, interval: unknownInterval() },
    place: raw.place,
    unresolvedContext: [],
    checkability: raw.checkability,
    material: raw.material,
    parentLocalId: raw.parentLocalId,
    notes: [],
  };

  const antecedents: string[] = [];
  for (const referent of raw.referents) {
    const failure = referentFailure(referent, scope, windowText, spansText);
    if (failure === null) {
      antecedents.push(referent.antecedent.quote);
      continue;
    }
    revertReferent(draft, referent.referent, referent.mention);
    draft.unresolvedContext.push(
      `The referent of '${referent.mention}' was not accepted: ${failure}.`,
    );
    draft.notes.push(`Unresolved referent '${referent.mention}' kept as written: ${failure}.`);
    draft.checkability = "needs_context";
  }
  for (const mention of raw.unresolvedMentions) {
    draft.unresolvedContext.push(`'${mention}' has no explicit antecedent in local context.`);
    draft.checkability = "needs_context";
  }
  if (
    PRONOUNS.has(draft.proposition.subject.toLowerCase()) &&
    draft.unresolvedContext.length === 0
  ) {
    draft.unresolvedContext.push(
      `The subject '${draft.proposition.subject}' is a pronoun without a resolved antecedent.`,
    );
    draft.checkability = "needs_context";
  }
  if (touched.some((segment) => segment.transcriptionUncertain)) {
    draft.unresolvedContext.push("The claim cites an OCR region whose transcription is uncertain.");
    draft.checkability = "needs_context";
  }

  const groundingText = [windowText, ...antecedents].join(" ");
  for (const [field, value] of groundedFields(draft)) {
    const missing = ungroundedToken(value, groundingText);
    if (missing)
      return reject(`${field} introduces '${missing}', which is absent from local context`);
  }

  if (raw.attribution.kind === "direct_assertion") {
    if (raw.attribution.quote !== null || raw.attribution.attributedTo !== null) {
      return reject("a direct assertion cannot carry an attribution source");
    }
    for (const segment of touched) {
      for (const cue of segment.text.matchAll(ATTRIBUTION_CUE)) {
        const at = segment.span.start + cue.index;
        const inside = orderedSpans.some((span) => span.start <= at && at < span.end);
        if (!inside) {
          return reject(
            `attribution cue '${cue[0]}' is outside the claim span; an attributed proposition cannot be a direct assertion`,
          );
        }
      }
    }
  } else {
    if (raw.attribution.quote === null)
      return reject("an attributed claim needs an attribution quote");
    const located = locateQuote(raw.attribution.quote, scope);
    if ("error" in located) return reject(`attribution quote rejected: ${located.error}`);
    if (!segmentIds.has(raw.attribution.quote.segmentId)) {
      return reject("the attribution quote is not in a segment the claim cites");
    }
    const attributionText = sourceText.slice(located.span.start, located.span.end);
    if (
      raw.attribution.attributedTo !== null &&
      !includesFolded(attributionText, raw.attribution.attributedTo) &&
      !antecedents.some((quote) => includesFolded(quote, raw.attribution.attributedTo!))
    ) {
      return reject(
        "attributedTo does not appear in the attribution quote or a resolved antecedent",
      );
    }
    draft.attribution.attributionSpan = located.span;
  }

  if (NEGATION.test(spansText) && !NEGATION.test(draft.text)) {
    return reject("the cited text is negated but the claim text drops the negation");
  }
  if (raw.negated && !(NEGATION.test(spansText) && NEGATION.test(draft.text))) {
    return reject(
      "the claim is marked negated without negation in both the cited text and the claim",
    );
  }
  const embedsStatement = new RegExp(ATTRIBUTION_CUE.source, "i").test(spansText);
  if (!raw.negated && NEGATION.test(draft.text) && !embedsStatement) {
    return reject("the claim text is negated but the claim is not marked negated");
  }

  if (raw.time.statedText !== null) {
    if (!includesFolded(segmentText, raw.time.statedText)) {
      return reject("time.statedText is not present in the cited segments");
    }
    if (!includesFolded(draft.text, raw.time.statedText)) {
      return reject("the claim text drops its stated time qualifier");
    }
    draft.time.interval = intervalFromStatedText(raw.time.statedText);
  } else {
    const hull = { start: orderedSpans[0]!.start, end: orderedSpans.at(-1)!.end };
    const yearInHull = [...sourceText.slice(hull.start, hull.end).matchAll(YEAR)].some(
      (year) => !raw.quantities.some((quantity) => quantity.rawText.includes(year[0])),
    );
    if (yearInHull) return reject("the cited text states a year but the claim records no time");
  }

  for (const quantity of raw.quantities) {
    if (!includesFolded(segmentText, quantity.rawText)) {
      return reject(`quantity '${quantity.rawText}' is not present in the cited segments`);
    }
    if (!includesFolded(draft.text, quantity.rawText)) {
      return reject(`the claim text does not preserve quantity '${quantity.rawText}'`);
    }
    if (
      quantity.denominatorText !== null &&
      !includesFolded(segmentText, quantity.denominatorText)
    ) {
      return reject(
        `denominator '${quantity.denominatorText}' is not present in the cited segments`,
      );
    }
    if (
      (quantity.kind === "percentage" || quantity.kind === "rate") &&
      quantity.denominatorText === null &&
      followedByDenominator(segmentText, quantity.rawText)
    ) {
      return reject(`quantity '${quantity.rawText}' drops its stated denominator`);
    }
  }
  for (const number of spansText.match(NUMBER) ?? []) {
    if (!draft.text.includes(number)) {
      return reject(`the claim text drops the number '${number}' from its cited text`);
    }
  }
  for (const number of draft.text.match(NUMBER) ?? []) {
    if (!groundingText.includes(number)) {
      return reject(`the claim text introduces the number '${number}'`);
    }
  }
  return { accepted: true, draft };
}

export function intervalFromStatedText(statedText: string): TimeInterval {
  const value = statedText.trim().toLowerCase();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return dayInterval(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const monthPattern = MONTHS.join("|");
  const dayFirst = value.match(new RegExp(`^(?:on )?(\\d{1,2}) (${monthPattern}),? (\\d{4})$`));
  if (dayFirst) {
    return dayInterval(Number(dayFirst[3]), MONTHS.indexOf(dayFirst[2]!) + 1, Number(dayFirst[1]));
  }
  const monthFirst = value.match(new RegExp(`^(?:on )?(${monthPattern}) (\\d{1,2}),? (\\d{4})$`));
  if (monthFirst) {
    return dayInterval(
      Number(monthFirst[3]),
      MONTHS.indexOf(monthFirst[1]!) + 1,
      Number(monthFirst[2]),
    );
  }
  const month = value.match(new RegExp(`^(?:in )?(${monthPattern}) (\\d{4})$`));
  if (month) {
    const year = Number(month[2]);
    const index = MONTHS.indexOf(month[1]!);
    return {
      earliest: new Date(Date.UTC(year, index, 1)).toISOString(),
      latest: new Date(Date.UTC(year, index + 1, 0, 23, 59, 59)).toISOString(),
      precision: "month",
      timezone: null,
    };
  }
  const year = value.match(/^(?:in )?(\d{4})$/);
  if (year) {
    return {
      earliest: new Date(Date.UTC(Number(year[1]), 0, 1)).toISOString(),
      latest: new Date(Date.UTC(Number(year[1]), 11, 31, 23, 59, 59)).toISOString(),
      precision: "year",
      timezone: null,
    };
  }
  return unknownInterval();
}

function dayInterval(year: number, month: number, day: number): TimeInterval {
  const start = new Date(Date.UTC(year, month - 1, day));
  if (start.getUTCMonth() !== month - 1 || start.getUTCDate() !== day) return unknownInterval();
  return {
    earliest: start.toISOString(),
    latest: new Date(Date.UTC(year, month - 1, day, 23, 59, 59)).toISOString(),
    precision: "day",
    timezone: null,
  };
}

function unknownInterval(): TimeInterval {
  return { earliest: null, latest: null, precision: null, timezone: null };
}

function locateQuote(
  reference: QuoteReference,
  scope: ChunkScope,
): { span: Span } | { error: string } {
  if (!scope.chunkSegmentIds.has(reference.segmentId)) {
    return { error: `segment ${reference.segmentId} is not part of this chunk` };
  }
  const segment = scope.segmentsById.get(reference.segmentId)!;
  const first = segment.text.indexOf(reference.quote);
  if (first < 0)
    return { error: `'${reference.quote}' is not an exact substring of ${segment.id}` };
  if (segment.text.indexOf(reference.quote, first + 1) >= 0) {
    return { error: `'${reference.quote}' occurs more than once in ${segment.id}` };
  }
  const start = segment.span.start + first;
  return { span: { start, end: start + reference.quote.length } };
}

function normalizeSpans(spans: Span[]): Span[] | null {
  const unique = [
    ...new Map(spans.map((span) => [`${span.start}:${span.end}`, span])).values(),
  ].sort((left, right) => left.start - right.start);
  for (let index = 1; index < unique.length; index += 1) {
    if (unique[index]!.start < unique[index - 1]!.end) return null;
  }
  return unique;
}

function localWindow(document: SegmentedDocument, segment: InventorySegment, scope: ChunkScope) {
  return document.segments
    .filter(
      (candidate) =>
        scope.chunkSegmentIds.has(candidate.id) &&
        (candidate.blockIndex === segment.blockIndex ||
          candidate.blockIndex === segment.blockIndex - 1),
    )
    .map((candidate) => candidate.text)
    .join(" ");
}

function referentFailure(
  referent: RawClaim["referents"][number],
  scope: ChunkScope,
  windowText: string,
  spansText: string,
): string | null {
  if (!includesFolded(spansText, referent.mention)) {
    return "the mention does not occur in the cited text";
  }
  const located = locateQuote(referent.antecedent, scope);
  if ("error" in located) return `antecedent ${located.error}`;
  if (!windowText.includes(referent.antecedent.quote)) {
    return "the antecedent is outside the same or preceding paragraph";
  }
  if (!includesFolded(referent.antecedent.quote, referent.referent)) {
    return "the referent is not written in the antecedent quote";
  }
  if (!PRONOUNS.has(referent.mention.toLowerCase())) {
    const lastWord = referent.mention.split(/\s+/).at(-1)!;
    const names = new Set(
      [...windowText.matchAll(/\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)+/gu)]
        .map((match) => match[0])
        .filter((name) => name.split(/\s+/).at(-1) === lastWord),
    );
    if (names.size > 1) return `'${referent.mention}' matches ${[...names].join(" and ")}`;
  }
  return null;
}

function revertReferent(draft: ClaimDraft, referent: string, mention: string) {
  const swap = (value: string) => value.split(referent).join(mention);
  draft.text = swap(draft.text);
  draft.retrievalText = swap(draft.retrievalText);
  draft.proposition = {
    subject: swap(draft.proposition.subject),
    predicate: swap(draft.proposition.predicate),
    object: draft.proposition.object === null ? null : swap(draft.proposition.object),
    qualifiers: draft.proposition.qualifiers.map(swap),
  };
  if (draft.attribution.attributedTo !== null) {
    draft.attribution.attributedTo = swap(draft.attribution.attributedTo);
  }
  if (draft.place !== null) draft.place = swap(draft.place);
}

function groundedFields(draft: ClaimDraft): Array<[string, string]> {
  return [
    ["text", draft.text],
    ["subject", draft.proposition.subject],
    ["object", draft.proposition.object ?? ""],
    ["place", draft.place ?? ""],
    ["attributedTo", draft.attribution.attributedTo ?? ""],
    ...draft.proposition.qualifiers.map((qualifier): [string, string] => ["qualifier", qualifier]),
  ];
}

/** Capitalized tokens name entities; each must be written in the local context. */
function ungroundedToken(value: string, context: string) {
  const folded = fold(context);
  for (const match of value.matchAll(/\p{Lu}[\p{L}\p{N}'’-]*/gu)) {
    const token = match[0].replace(/['’]s$/u, "");
    if (ENGLISH_FUNCTION_WORDS.has(token.toLowerCase()) || PRONOUNS.has(token.toLowerCase())) {
      continue;
    }
    if (!new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(fold(token))}`, "u").test(folded)) {
      return token;
    }
  }
  return null;
}

function followedByDenominator(text: string, rawText: string) {
  const folded = fold(text);
  const target = fold(rawText);
  for (let at = folded.indexOf(target); at >= 0; at = folded.indexOf(target, at + 1)) {
    if (DENOMINATOR_LEAD.test(folded.slice(at + target.length))) return true;
  }
  return false;
}

function includesFolded(haystack: string, needle: string) {
  return fold(haystack).includes(fold(needle));
}

function fold(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}

function collapse(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reject(reason: string): ClaimValidation {
  return { accepted: false, reason };
}
