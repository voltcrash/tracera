import { createHash } from "node:crypto";
import {
  claimSchema,
  inputCoverageSchema,
  type ClaimV2,
  type CoreIssue,
  type InputCoverage,
  type Span,
} from "@repo/contracts/core-v2";
import type { SegmentedDocument } from "./segmentation.js";
import type { ClaimDraft } from "./validation.js";

export interface AcceptedClaim {
  draft: ClaimDraft;
  parent: ClaimDraft | null;
}

export type SegmentOutcome =
  | { kind: "disposition"; disposition: "opinion" | "background" | "non_checkable"; reason: string }
  | { kind: "declared_factual" }
  | { kind: "missing" }
  | { kind: "provider_failed" }
  | { kind: "budget_deferred" };

export interface InventoryResult {
  claims: ClaimV2[];
  coverage: InputCoverage[];
  issues: CoreIssue[];
  incomplete: boolean;
}

type NonDuplicateDisposition = "factual_claim" | "deferred";

export function buildInventory(input: {
  documents: SegmentedDocument[];
  accepted: AcceptedClaim[];
  outcomes: Map<string, SegmentOutcome>;
  maxAnalyzedClaims: number | null;
}): InventoryResult {
  const issues: CoreIssue[] = [];
  let incomplete = false;

  const groups = new Map<string, { id: string; scope: string; drafts: AcceptedClaim[] }>();
  for (const accepted of input.accepted) {
    const scope = scopeKey(accepted.draft);
    const id = claimId(accepted.draft.documentId, scope);
    const group = groups.get(id) ?? { id, scope, drafts: [] };
    group.drafts.push(accepted);
    groups.set(id, group);
  }
  const idByDraft = new Map<ClaimDraft, string>();
  for (const group of groups.values()) {
    for (const { draft } of group.drafts) idByDraft.set(draft, group.id);
    group.drafts.sort(
      (left, right) =>
        left.draft.documentIndex - right.draft.documentIndex ||
        left.draft.spans[0]!.start - right.draft.spans[0]!.start,
    );
  }

  const ordered = [...groups.values()].sort((left, right) => {
    const a = left.drafts[0]!.draft;
    const b = right.drafts[0]!.draft;
    return a.documentIndex - b.documentIndex || a.spans[0]!.start - b.spans[0]!.start;
  });

  const firstByScope = new Map<string, string>();
  const duplicateOf = new Map<string, string>();
  for (const group of ordered) {
    const canonical = firstByScope.get(group.scope);
    if (canonical === undefined) firstByScope.set(group.scope, group.id);
    else duplicateOf.set(group.id, canonical);
  }

  const priority = ordered
    .filter((group) => !duplicateOf.has(group.id))
    .map((group) => ({ group, draft: mergeDrafts(group.drafts) }))
    .sort(
      (left, right) =>
        Number(right.draft.material) - Number(left.draft.material) ||
        Number(right.draft.checkability === "checkable") -
          Number(left.draft.checkability === "checkable") ||
        left.draft.documentIndex - right.draft.documentIndex ||
        left.draft.spans[0]!.start - right.draft.spans[0]!.start,
    );
  const dispositionById = new Map<string, NonDuplicateDisposition>();
  priority.forEach(({ group }, index) => {
    dispositionById.set(
      group.id,
      input.maxAnalyzedClaims !== null && index >= input.maxAnalyzedClaims
        ? "deferred"
        : "factual_claim",
    );
  });
  const deferredCount =
    priority.length -
    [...dispositionById.values()].filter((value) => value === "factual_claim").length;
  if (deferredCount > 0) {
    incomplete = true;
    issues.push(
      issue(
        "deferred_processing",
        `${deferredCount} inventoried claims exceed the analysis limit of ${input.maxAnalyzedClaims} and are deferred.`,
      ),
    );
  }

  const claims: ClaimV2[] = ordered.map((group) => {
    const merged = mergeDrafts(group.drafts);
    const parentDraft = group.drafts.find((accepted) => accepted.parent !== null)?.parent ?? null;
    const parentId = parentDraft ? (idByDraft.get(parentDraft) ?? null) : null;
    const canonical = duplicateOf.get(group.id) ?? null;
    return claimSchema.parse({
      id: group.id,
      documentId: merged.documentId,
      text: merged.text,
      spans: merged.spans,
      occurrenceSpans: occurrenceSpans(group.drafts.map(({ draft }) => draft)),
      retrievalText: merged.retrievalText,
      proposition: merged.proposition,
      attribution: merged.attribution,
      negated: merged.negated,
      quantities: merged.quantities,
      time: merged.time,
      place: merged.place,
      unresolvedContext: merged.unresolvedContext,
      checkability: merged.checkability,
      material: merged.material,
      parentClaimId: parentId === group.id ? null : parentId,
      duplicateOfClaimId: canonical,
      coverageDisposition: dispositionById.get(canonical ?? group.id)!,
    } satisfies ClaimV2);
  });

  const coverage = input.documents.map((document) => {
    const segments: InputCoverage["segments"] = [];
    let omittedCharacters = 0;
    let documentIncomplete = false;
    for (const segment of document.segments) {
      if (!segment.substantive) continue;
      const covering = claims.filter(
        (claim) =>
          claim.documentId === document.snapshot.id &&
          [...claim.spans, ...claim.occurrenceSpans].some((span) => overlaps(span, segment.span)),
      );
      if (segment.handling === "user_caption") {
        segments.push({
          span: segment.span,
          disposition: "background",
          claimIds: [],
          reason: "User-supplied caption is retained as a discovery hint, not as a factual claim.",
        });
        continue;
      }
      if (segment.handling === "unsupported_language") {
        documentIncomplete = true;
        segments.push({
          span: segment.span,
          disposition: "deferred",
          claimIds: [],
          reason: "The segment language is not supported by the validated claim extractor.",
        });
        issues.push(
          issue(
            "unsupported_language",
            `Segment ${segment.span.start}-${segment.span.end} is in an unsupported language and was not inventoried.`,
            document.snapshot.id,
          ),
        );
        continue;
      }
      if (covering.length > 0) {
        const factual = covering.some((claim) => claim.coverageDisposition === "factual_claim");
        if (!factual) documentIncomplete = true;
        segments.push({
          span: segment.span,
          disposition: factual ? "factual_claim" : "deferred",
          claimIds: covering.map((claim) => claim.id).sort(),
          reason: factual ? null : "Every claim in this segment is deferred by the analysis limit.",
        });
        continue;
      }
      const outcome = input.outcomes.get(segment.id) ?? { kind: "missing" };
      if (outcome.kind === "disposition") {
        segments.push({
          span: segment.span,
          disposition: outcome.disposition,
          claimIds: [],
          reason: outcome.reason,
        });
        continue;
      }
      documentIncomplete = true;
      if (outcome.kind === "budget_deferred") {
        segments.push({
          span: segment.span,
          disposition: "deferred",
          claimIds: [],
          reason: "The extraction budget was exhausted before this segment was inventoried.",
        });
        continue;
      }
      omittedCharacters += segment.span.end - segment.span.start;
      if (outcome.kind === "provider_failed") continue;
      issues.push(
        issue(
          "human_review_required",
          outcome.kind === "declared_factual"
            ? `Segment ${segment.span.start}-${segment.span.end} was declared factual but no valid claim was accepted for it.`
            : `Segment ${segment.span.start}-${segment.span.end} received neither a claim nor a disposition.`,
          document.snapshot.id,
        ),
      );
    }
    if (documentIncomplete) incomplete = true;
    const total = document.snapshot.normalizedText.length;
    return inputCoverageSchema.parse({
      documentId: document.snapshot.id,
      segments,
      charactersCovered: total - omittedCharacters,
      charactersTotal: total,
      extractionStatus: documentIncomplete ? "partial" : "complete",
    } satisfies InputCoverage);
  });

  return { claims, coverage, issues, incomplete };
}

export function scopeKey(draft: ClaimDraft) {
  return JSON.stringify({
    subject: norm(draft.proposition.subject),
    predicate: norm(draft.proposition.predicate),
    object: draft.proposition.object === null ? null : norm(draft.proposition.object),
    qualifiers: draft.proposition.qualifiers.map(norm).sort(),
    attribution: {
      kind: draft.attribution.kind,
      attributedTo:
        draft.attribution.attributedTo === null ? null : norm(draft.attribution.attributedTo),
    },
    negated: draft.negated,
    quantities: draft.quantities
      .map((quantity) =>
        JSON.stringify({
          rawText: norm(quantity.rawText),
          value: quantity.value,
          unit: quantity.unit === null ? null : norm(quantity.unit),
          denominatorText:
            quantity.denominatorText === null ? null : norm(quantity.denominatorText),
          kind: quantity.kind,
        }),
      )
      .sort(),
    time: {
      statedText: draft.time.statedText === null ? null : norm(draft.time.statedText),
      interval: draft.time.interval,
    },
    place: draft.place === null ? null : norm(draft.place),
  });
}

function claimId(documentId: string, scope: string) {
  return `claim_${createHash("sha256")
    .update(JSON.stringify([documentId, scope]))
    .digest("hex")}`;
}

function mergeDrafts(accepted: AcceptedClaim[]): ClaimDraft {
  const primary = accepted[0]!.draft;
  const unresolved = [...new Set(accepted.flatMap(({ draft }) => draft.unresolvedContext))];
  const rank = { needs_context: 3, unanswerable: 2, checkable: 1, not_checkable: 0 } as const;
  const checkability = accepted
    .map(({ draft }) => draft.checkability)
    .reduce((worst, next) => (rank[next] > rank[worst] ? next : worst));
  return {
    ...primary,
    unresolvedContext: unresolved,
    checkability,
    material: accepted.some(({ draft }) => draft.material),
  };
}

function occurrenceSpans(drafts: ClaimDraft[]): Span[] {
  const primary = drafts[0]!.spans;
  const kept: Span[] = [];
  for (const draft of drafts.slice(1)) {
    if (draft.spans.some((span) => [...primary, ...kept].some((other) => overlaps(span, other)))) {
      continue;
    }
    kept.push(...draft.spans);
  }
  return kept.sort((left, right) => left.start - right.start);
}

function overlaps(left: Span, right: Span) {
  return left.start < right.end && right.start < left.end;
}

function norm(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?]+$/u, "");
}

function issue(
  code: CoreIssue["code"],
  message: string,
  snapshotId: string | null = null,
): CoreIssue {
  return { code, severity: "warning", message, claimId: null, snapshotId, url: null };
}
