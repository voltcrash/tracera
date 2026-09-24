import {
  ANALYSIS_FOCUSED_MAX_SELECTED_CLAIMS,
  ANALYSIS_FOCUSED_POLICY_VERSION,
  ANALYSIS_FOCUSED_SCORE_FORMULA_VERSION,
  ANALYSIS_FOCUSED_SELECTION_VERSION,
  ANALYSIS_RESOLUTION_COVERAGE_THRESHOLD,
  claimSchema,
  focusedSelectionClaimSchema,
  focusedSelectionSchema,
  scorecardSchema,
  type Claim,
  type AnalysisIssue,
  type DocumentSnapshot,
  type FocusedConcreteSignal,
  type FocusedSelection,
  type FocusedSelectionClaim,
  type InputCoverage,
  type Scorecard,
  type ScoreNullReason,
  type StageResult,
  type StageStatus,
} from "@repo/contracts/analysis";
import type { ScoreReportData } from "../types";

export interface FocusedSelectionInput {
  claims: Claim[];
  snapshots: DocumentSnapshot[];
  coverage: InputCoverage[];
  inventoryStatus: StageStatus;
  primarySnapshotId?: string | null;
  inputSnapshotHash?: string | null;
}

export interface FocusedSelectionResult {
  claims: Claim[];
  selectedClaims: Claim[];
  selection: FocusedSelection;
  issues: AnalysisIssue[];
}

interface WorkingClaim {
  claim: Claim;
  originalCoverageDisposition: Claim["coverageDisposition"];
  canonical: boolean;
  position: FocusedSelectionClaim["ranking"]["position"];
  concreteSignals: FocusedConcreteSignal[];
  documentOrder: number | null;
  spanStart: number | null;
  uncertainOcr: boolean;
}

const POSITION_RANK: Record<FocusedSelectionClaim["ranking"]["position"], number> = {
  headline: 4,
  heading: 3,
  lead: 2,
  body: 1,
  unknown: 0,
};

const CHECKABILITY_RANK: Record<Claim["checkability"], number> = {
  checkable: 3,
  needs_context: 2,
  unanswerable: 1,
  not_checkable: 0,
};

/**
 * Selects the focused analysis set after the complete inventory is available.
 * The returned `claims` array remains the full inventory; only `selectedClaims`
 * may be sent to evidence-bearing stages.
 */
export function selectTopClaims(input: FocusedSelectionInput): FocusedSelectionResult {
  const parsedClaims = input.claims.map((claim) => claimSchema.parse(claim));
  const snapshotsById = new Map(input.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const documentOrder = new Map(input.snapshots.map((snapshot, index) => [snapshot.id, index]));
  const orderedForCanonicalization = [...parsedClaims].sort((left, right) =>
    compareDocumentOrder(left, right, documentOrder),
  );

  // Task 05 normally supplies duplicateOfClaimId. The scope fallback protects
  // this boundary when an injected inventory producer forgot a cross-document
  // duplicate link: identical scoped propositions still cannot fill two slots.
  const ownerByScope = new Map<string, string>();
  const derivedDuplicateOf = new Map<string, string>();
  for (const claim of orderedForCanonicalization) {
    if (claim.duplicateOfClaimId !== null) continue;
    const scope = propositionScopeKey(claim);
    const owner = ownerByScope.get(scope);
    if (owner === undefined) ownerByScope.set(scope, claim.id);
    else derivedDuplicateOf.set(claim.id, owner);
  }

  const normalizedClaims = parsedClaims.map((claim) => {
    const duplicateOfClaimId = claim.duplicateOfClaimId ?? derivedDuplicateOf.get(claim.id) ?? null;
    return claimSchema.parse({ ...claim, duplicateOfClaimId }) satisfies Claim;
  });
  const originalById = new Map(parsedClaims.map((claim) => [claim.id, claim]));
  const working = normalizedClaims.map((claim) => {
    const snapshot = snapshotsById.get(claim.documentId);
    const ranking = rankingSignals(claim, snapshot, documentOrder.get(claim.documentId) ?? null);
    return {
      claim,
      originalCoverageDisposition: originalById.get(claim.id)!.coverageDisposition,
      canonical: claim.duplicateOfClaimId === null,
      ...ranking,
    } satisfies WorkingClaim;
  });
  const orderedWorking = [...working].sort((left, right) =>
    compareDocumentOrder(left.claim, right.claim, documentOrder),
  );

  const eligible = working.filter((entry) => isEligible(entry)).sort(compareEligibleClaims);
  const selected = eligible.slice(0, ANALYSIS_FOCUSED_MAX_SELECTED_CLAIMS);
  const selectedIds = new Set(selected.map(({ claim }) => claim.id));
  const rankById = new Map(selected.map(({ claim }, index) => [claim.id, index + 1]));

  const finalClaims = normalizedClaims.map((claim) => {
    const entry = working.find(({ claim: candidate }) => candidate.id === claim.id)!;
    if (
      entry.canonical &&
      entry.originalCoverageDisposition === "factual_claim" &&
      !selectedIds.has(claim.id)
    ) {
      return claimSchema.parse({ ...claim, coverageDisposition: "deferred" }) satisfies Claim;
    }
    return claim;
  });
  const finalById = new Map(finalClaims.map((claim) => [claim.id, claim]));

  const entries = orderedWorking.map((entry) => {
    const { claim } = entry;
    const rank = rankById.get(claim.id) ?? null;
    const status: FocusedSelectionClaim["status"] =
      rank !== null
        ? "analyzed"
        : entry.canonical && entry.originalCoverageDisposition === "factual_claim"
          ? "deferred"
          : entry.originalCoverageDisposition === "deferred"
            ? "deferred"
            : "excluded";
    const reasonCode = reasonFor(
      entry,
      status,
      rank === null && eligible.some(({ claim: item }) => item.id === claim.id),
    );
    const finalClaim = finalById.get(claim.id)!;
    return focusedSelectionClaimSchema.parse({
      claimId: claim.id,
      status,
      rank,
      canonical: entry.canonical,
      originalCoverageDisposition: entry.originalCoverageDisposition,
      coverageDisposition: finalClaim.coverageDisposition,
      checkability: claim.checkability,
      material: claim.material,
      reasonCode,
      reason: reasonText(entry, status, rank, reasonCode),
      ranking: {
        position: entry.position,
        concreteSignals: entry.concreteSignals,
        documentOrder: entry.documentOrder,
        spanStart: entry.spanStart,
        tieBreaker: "document_order_then_claim_id",
      },
    });
  });

  const deferredClaimIds = entries
    .filter(({ status }) => status === "deferred")
    .map(({ claimId }) => claimId);
  const excludedClaimIds = entries
    .filter(({ status }) => status === "excluded")
    .map(({ claimId }) => claimId);
  const totalCharacters = input.coverage.reduce((sum, item) => sum + item.charactersTotal, 0);
  const coveredCharacters = input.coverage.reduce((sum, item) => sum + item.charactersCovered, 0);
  const canonicalClaims = orderedWorking.filter(({ canonical }) => canonical);
  const canonicalFactualClaims = canonicalClaims.filter(
    ({ originalCoverageDisposition }) => originalCoverageDisposition === "factual_claim",
  );
  const inventory = {
    totalClaims: working.length,
    canonicalClaims: canonicalClaims.length,
    duplicateClaims: working.length - canonicalClaims.length,
    canonicalFactualClaims: canonicalFactualClaims.length,
    eligibleClaims: eligible.length,
    analyzedClaims: selected.length,
    deferredClaims: deferredClaimIds.length,
    excludedClaims: excludedClaimIds.length,
  };
  const selection = focusedSelectionSchema.parse({
    policyVersion: ANALYSIS_FOCUSED_POLICY_VERSION,
    selectionVersion: ANALYSIS_FOCUSED_SELECTION_VERSION,
    maxSelectedClaims: ANALYSIS_FOCUSED_MAX_SELECTED_CLAIMS,
    inputSnapshotHash:
      input.inputSnapshotHash ??
      (input.primarySnapshotId === undefined || input.primarySnapshotId === null
        ? null
        : (snapshotsById.get(input.primarySnapshotId)?.contentHash ?? null)),
    inventoryStatus: input.inventoryStatus,
    inventory,
    coverage: {
      documents: input.coverage.length,
      completeDocuments: input.coverage.filter(
        ({ extractionStatus }) => extractionStatus === "complete",
      ).length,
      partialDocuments: input.coverage.filter(
        ({ extractionStatus }) => extractionStatus !== "complete",
      ).length,
      totalCharacters,
      coveredCharacters,
      omittedCharacters: Math.max(0, totalCharacters - coveredCharacters),
    },
    claims: entries,
    selectedClaimIds: selected.map(({ claim }) => claim.id),
    deferredClaimIds,
    excludedClaimIds,
    shortfallReason:
      selected.length < ANALYSIS_FOCUSED_MAX_SELECTED_CLAIMS
        ? shortfallReason(selected.length, eligible.length, input.inventoryStatus)
        : null,
  });

  const issues: AnalysisIssue[] = [];
  const selectionDeferred = entries.filter(
    ({ reasonCode }) => reasonCode === "deferred_by_selection_limit",
  );
  if (selectionDeferred.length > 0) {
    issues.push({
      code: "deferred_processing",
      severity: "warning",
      message: `${selectionDeferred.length} canonical factual claim(s) were inventoried but deferred outside the focused limit of ${ANALYSIS_FOCUSED_MAX_SELECTED_CLAIMS}.`,
      claimId: null,
      snapshotId: null,
      url: null,
    });
  }

  return {
    claims: finalClaims,
    selectedClaims: selected.map(({ claim }) => finalById.get(claim.id)!),
    selection,
    issues,
  };
}

/** Keeps the complete extraction coverage while making a score input selected-claim-only. */
export function coverageForSelectedClaims(
  coverage: InputCoverage[],
  selectedClaimIds: ReadonlySet<string>,
): InputCoverage[] {
  return coverage.map((document) => ({
    ...document,
    segments: document.segments.map((segment) => ({
      ...segment,
      claimIds: segment.claimIds.filter((claimId) => selectedClaimIds.has(claimId)),
    })),
  }));
}

/** Adds the focused selected-claim denominator when a custom scorer returns unscoped data. */
export function accountFocusedScore(
  result: StageResult<ScoreReportData>,
  selection: FocusedSelection,
): StageResult<ScoreReportData> {
  if (result.data === null) return result;
  const base = result.data.scorecard;
  const selectedClaimCount = selection.selectedClaimIds.length;
  const resolvedClaimCount = base.counts.supported + base.counts.contradicted;
  const labeled =
    resolvedClaimCount + base.counts.misleading + base.counts.mixed + base.counts.unverified;
  const resolutionCoverage =
    selectedClaimCount === 0 ? null : resolvedClaimCount / selectedClaimCount;
  const nullReasons = focusedNullReasons(
    base,
    resolutionCoverage,
    selectedClaimCount,
    resolvedClaimCount,
  );
  const scorecard = scorecardSchema.parse({
    ...base,
    formulaVersion: ANALYSIS_FOCUSED_SCORE_FORMULA_VERSION,
    factualScore:
      nullReasons.length === 0 ? (100 * base.counts.supported) / resolvedClaimCount : null,
    nullReasons,
    selectedClaimCount,
    resolvedClaimCount,
    counts: {
      ...base.counts,
      eligibleFactualClaims: selectedClaimCount,
      deferredClaims: selection.inventory.deferredClaims,
      omittedClaims: Math.max(0, selectedClaimCount - labeled),
    },
    resolutionCoverage,
  }) satisfies Scorecard;
  return { ...result, data: { ...result.data, scorecard } };
}

function focusedNullReasons(
  scorecard: Scorecard,
  resolutionCoverage: number | null,
  selectedClaimCount: number,
  resolvedClaimCount: number,
) {
  const reasons = [...scorecard.nullReasons] as ScoreNullReason[];
  if (selectedClaimCount === 0 && !reasons.includes("no_checkable_claims"))
    reasons.push("no_checkable_claims");
  if (resolvedClaimCount === 0 && !reasons.includes("zero_resolved_denominator"))
    reasons.push("zero_resolved_denominator");
  if (
    resolutionCoverage !== null &&
    resolutionCoverage < ANALYSIS_RESOLUTION_COVERAGE_THRESHOLD &&
    !reasons.includes("resolution_coverage_below_threshold")
  ) {
    reasons.push("resolution_coverage_below_threshold");
  }
  return [...new Set(reasons)];
}

function isEligible(entry: WorkingClaim) {
  return (
    entry.canonical &&
    entry.originalCoverageDisposition === "factual_claim" &&
    entry.claim.checkability === "checkable" &&
    entry.claim.material &&
    !entry.uncertainOcr
  );
}

function compareEligibleClaims(left: WorkingClaim, right: WorkingClaim) {
  return (
    Number(right.claim.material) - Number(left.claim.material) ||
    CHECKABILITY_RANK[right.claim.checkability] - CHECKABILITY_RANK[left.claim.checkability] ||
    POSITION_RANK[right.position] - POSITION_RANK[left.position] ||
    right.concreteSignals.length - left.concreteSignals.length ||
    compareNullable(left.documentOrder, right.documentOrder) ||
    compareNullable(left.spanStart, right.spanStart) ||
    compareText(left.claim.id, right.claim.id)
  );
}

function compareDocumentOrder(left: Claim, right: Claim, documentOrder: Map<string, number>) {
  return (
    compareNullable(
      documentOrder.get(left.documentId) ?? null,
      documentOrder.get(right.documentId) ?? null,
    ) ||
    compareNullable(firstSpanStart(left), firstSpanStart(right)) ||
    compareText(left.id, right.id)
  );
}

function rankingSignals(
  claim: Claim,
  snapshot: DocumentSnapshot | undefined,
  documentOrder: number | null,
) {
  const spans = [...claim.spans, ...claim.occurrenceSpans];
  const position = claimPosition(spans, snapshot);
  const concreteSignals: FocusedConcreteSignal[] = [];
  const entityText = [
    claim.proposition.subject,
    claim.proposition.object,
    ...claim.proposition.qualifiers,
    claim.attribution.attributedTo,
  ]
    .filter((value): value is string => value !== null)
    .join(" ");
  if (hasNamedEntity(entityText)) concreteSignals.push("entity");
  if (claim.time.statedText !== null || /\b(?:19|20)\d{2}\b/u.test(claim.text))
    concreteSignals.push("date");
  if (claim.place !== null) concreteSignals.push("place");
  if (
    claim.quantities.length > 0 ||
    /\b\d[\d,]*(?:\.\d+)?\s*(?:%|percent|million|billion|thousand)?\b/iu.test(claim.text)
  )
    concreteSignals.push("quantity");
  if (isMeasurableEvent(claim)) concreteSignals.push("measurable_event");
  return {
    position,
    concreteSignals,
    documentOrder,
    spanStart: firstSpanStart(claim),
    uncertainOcr:
      snapshot?.locators.some(
        (locator) =>
          locator.transcriptionUncertain && spans.some((span) => overlaps(locator.span, span)),
      ) ?? false,
  };
}

function claimPosition(
  spans: Claim["spans"],
  snapshot: DocumentSnapshot | undefined,
): FocusedSelectionClaim["ranking"]["position"] {
  if (snapshot === undefined) return "unknown";
  const contains = (locator: DocumentSnapshot["locators"][number]) =>
    spans.some((span) => locator.span.start <= span.start && span.end <= locator.span.end);
  if (snapshot.locators.some((locator) => locator.kind === "title" && contains(locator)))
    return "headline";
  if (snapshot.locators.some((locator) => locator.kind === "heading" && contains(locator)))
    return "heading";
  const paragraphs = snapshot.locators
    .filter(({ kind }) => kind === "paragraph")
    .sort((left, right) => left.span.start - right.span.start);
  const firstParagraph = paragraphs[0];
  if (
    snapshot.extractionMethod === "structured_html" &&
    firstParagraph !== undefined &&
    contains(firstParagraph)
  )
    return "lead";
  if (snapshot.locators.some(contains)) return "body";
  return "unknown";
}

function reasonFor(
  entry: WorkingClaim,
  status: FocusedSelectionClaim["status"],
  eligibleButNotSelected: boolean,
): FocusedSelectionClaim["reasonCode"] {
  if (status === "analyzed") return "selected_material_checkable";
  if (!entry.canonical) return "duplicate_claim";
  if (entry.originalCoverageDisposition === "deferred") return "deferred_by_extraction_limit";
  if (entry.originalCoverageDisposition !== "factual_claim") {
    if (entry.originalCoverageDisposition === "opinion") return "opinion";
    if (entry.originalCoverageDisposition === "background") return "background";
    return "non_checkable";
  }
  if (entry.uncertainOcr) return "uncertain_ocr";
  if (!entry.claim.material) return "not_material";
  if (entry.claim.checkability === "needs_context") return "ambiguous_context";
  if (entry.claim.checkability === "unanswerable") return "unanswerable";
  if (entry.claim.checkability === "not_checkable") return "not_checkable";
  if (eligibleButNotSelected) return "deferred_by_selection_limit";
  return "deferred_by_selection_limit";
}

function reasonText(
  entry: WorkingClaim,
  status: FocusedSelectionClaim["status"],
  rank: number | null,
  reasonCode: FocusedSelectionClaim["reasonCode"],
) {
  if (status === "analyzed") {
    const position =
      entry.position === "body" || entry.position === "unknown"
        ? ""
        : `; verified ${entry.position} position`;
    const concrete =
      entry.concreteSignals.length === 0
        ? ""
        : `; concrete signals: ${entry.concreteSignals.join(", ")}`;
    return `Selected at focused rank ${rank}${position}${concrete}. Material, factual, and checkable claims are ranked without model confidence.`;
  }
  switch (reasonCode) {
    case "deferred_by_selection_limit":
      return "The canonical factual claim is valid but falls outside the focused top-three selection limit.";
    case "deferred_by_extraction_limit":
      return "The claim was retained in the inventory but was already deferred by extraction limits.";
    case "duplicate_claim":
      return "This claim is a duplicate of a canonical proposition and cannot occupy another focused slot.";
    case "ambiguous_context":
      return "The claim remains deferred because its context or referent is unresolved.";
    case "uncertain_ocr":
      return "The claim remains deferred because its source text intersects an uncertain OCR region.";
    case "not_material":
      return "The claim is factual but not marked material, so it is outside focused eligibility.";
    case "unanswerable":
      return "The claim is retained but unanswerable as scoped, so it is outside focused eligibility.";
    case "not_checkable":
      return "The claim is retained but not checkable as scoped, so it is outside focused eligibility.";
    case "opinion":
      return "Opinion content is preserved in the inventory and is not a factual claim for focused analysis.";
    case "background":
      return "Background content is preserved in the inventory and is not selected for factual analysis.";
    case "non_checkable":
      return "Non-checkable content is preserved in the inventory and is not selected for factual analysis.";
    case "selected_material_checkable":
      return "Selected for focused analysis.";
  }
}

function shortfallReason(selected: number, eligible: number, inventoryStatus: StageStatus) {
  if (inventoryStatus !== "complete") {
    return `Only ${selected} of ${ANALYSIS_FOCUSED_MAX_SELECTED_CLAIMS} focused slots were selected from a ${inventoryStatus} inventory; incomplete or omitted input remains explicit.`;
  }
  if (eligible === 0) {
    return "No canonical claims are both material and checkable; opinion, background, ambiguous, unanswerable, duplicate, and other excluded work remains listed.";
  }
  return `Only ${eligible} canonical claims are eligible for focused analysis, so ${selected} claim(s) were selected.`;
}

function propositionScopeKey(claim: Claim) {
  return JSON.stringify({
    proposition: {
      subject: normalizeText(claim.proposition.subject),
      predicate: normalizeText(claim.proposition.predicate),
      object: claim.proposition.object === null ? null : normalizeText(claim.proposition.object),
      qualifiers: claim.proposition.qualifiers.map(normalizeText).sort(compareText),
    },
    attribution: {
      kind: claim.attribution.kind,
      attributedTo:
        claim.attribution.attributedTo === null
          ? null
          : normalizeText(claim.attribution.attributedTo),
    },
    negated: claim.negated,
    quantities: claim.quantities
      .map((quantity) => ({
        rawText: normalizeText(quantity.rawText),
        value: quantity.value,
        unit: quantity.unit === null ? null : normalizeText(quantity.unit),
        denominatorText:
          quantity.denominatorText === null ? null : normalizeText(quantity.denominatorText),
        kind: quantity.kind,
      }))
      .sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right))),
    time: {
      statedText: claim.time.statedText === null ? null : normalizeText(claim.time.statedText),
      interval: claim.time.interval,
    },
    place: claim.place === null ? null : normalizeText(claim.place),
  });
}

function normalizeText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.,;:!?]+$/u, "");
}

function firstSpanStart(claim: Claim) {
  return [...claim.spans, ...claim.occurrenceSpans].reduce<number | null>(
    (start, span) => (start === null ? span.start : Math.min(start, span.start)),
    null,
  );
}

function hasNamedEntity(value: string) {
  const ignored = new Set(["A", "An", "At", "By", "For", "In", "It", "On", "The", "This", "That"]);
  return value.split(/\s+/u).some((token) => {
    const cleaned = token.replace(/^[^\p{L}]|[^\p{L}\p{N}'’-]+$/gu, "");
    return cleaned.length > 1 && !ignored.has(cleaned) && /^[A-Z][\p{L}\p{M}'’-]*$/u.test(cleaned);
  });
}

function isMeasurableEvent(claim: Claim) {
  return (
    (claim.quantities.length > 0 || claim.time.statedText !== null) &&
    /\b(?:opened|closed|fell|rose|grew|increased|decreased|reached|produced|sold|bought|won|lost|measured|approved|rejected|signed|voted|elected|arrested|died|reported)\b/iu.test(
      `${claim.proposition.predicate} ${claim.text}`,
    )
  );
}

function overlaps(left: { start: number; end: number }, right: { start: number; end: number }) {
  return left.start < right.end && right.start < left.end;
}

function compareNullable(left: number | null, right: number | null) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
