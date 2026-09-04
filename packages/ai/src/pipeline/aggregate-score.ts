import type { ClaimVerdict, FramingAnalysis, ScoreDimension, TraceraScore } from "./types";

export function aggregateScore(claims: ClaimVerdict[], framing?: FramingAnalysis): TraceraScore {
  const factualAccuracy = weightedAverage(
    claims,
    (claim) => verdictValue(claim.verdict),
    (claim) => checkabilityWeight(claim.claim.checkability),
  );
  const sourceCorroboration = average(
    claims.map((claim) =>
      Math.min((claim.supportingSources.length + claim.contradictingSources.length) / 3, 1),
    ),
  );
  const evidenceQuality = average(claims.map((claim) => claim.evidenceQuality));
  const sourceReputation = average(
    claims.flatMap((claim) => claim.consideredSources).map((source) => source.credibility ?? 0.5),
  );
  const framingManipulation =
    framing?.integrityScore ??
    average(claims.map((claim) => legacyFramingScore(claim.claim.claimText)));
  const newestEvidenceAt =
    claims
      .flatMap((claim) => [...claim.supportingSources, ...claim.contradictingSources])
      .map((source) => source.publishedAt)
      .filter((date): date is string => Boolean(date))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const overall = average([
    factualAccuracy,
    sourceCorroboration,
    framingManipulation,
    evidenceQuality,
    sourceReputation,
  ]);

  return {
    overall: toPercent(overall),
    factualAccuracy: dimension(factualAccuracy),
    sourceCorroboration: dimension(sourceCorroboration),
    framingManipulation: dimension(framingManipulation),
    evidenceQuality: dimension(evidenceQuality),
    sourceReputation: dimension(sourceReputation),
    recency: { flag: recencyFlag(newestEvidenceAt), newestEvidenceAt },
  };
}

function verdictValue(verdict: ClaimVerdict["verdict"]) {
  return {
    supported: 1,
    mixed: 0.55,
    misleading: 0.35,
    contradicted: 0,
    unverified: 0.5,
  }[verdict];
}

function checkabilityWeight(checkability: ClaimVerdict["claim"]["checkability"]) {
  return { checkable: 1, needs_context: 0.65, not_checkable: 0.2 }[checkability];
}

/** Compatibility fallback for analyses stored before article-level framing. */
function legacyFramingScore(text: string) {
  const loadedLanguage = /\b(shocking|disaster|scandal|traitor|evil|miracle|destroys?|exposed)\b/gi;
  const matches = text.match(loadedLanguage)?.length ?? 0;
  return Math.max(0, 1 - matches * 0.15);
}

function recencyFlag(date: string | null): TraceraScore["recency"]["flag"] {
  if (!date || Number.isNaN(Date.parse(date))) return "unknown";
  const ageDays = (Date.now() - Date.parse(date)) / 86_400_000;
  if (ageDays <= 30) return "current";
  if (ageDays <= 365) return "recent";
  return "aging";
}

function weightedAverage<T>(
  items: T[],
  getValue: (item: T) => number,
  getWeight: (item: T) => number,
) {
  const totalWeight = items.reduce((sum, item) => sum + getWeight(item), 0);
  if (totalWeight === 0) return 0;
  return items.reduce((sum, item) => sum + getValue(item) * getWeight(item), 0) / totalWeight;
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dimension(score: number): ScoreDimension {
  return {
    score: toPercent(score),
    label: score >= 0.75 ? "strong" : score >= 0.45 ? "moderate" : "weak",
  };
}

function toPercent(score: number) {
  return Number((Math.max(0, Math.min(1, score)) * 100).toFixed(1));
}
