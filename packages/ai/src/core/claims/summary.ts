import type { ExtractClaimsV2Data } from "../types.js";

/**
 * Counts downstream stages need. `noCheckableClaims` is the explicit no-claim
 * outcome for opinion-only input; it must never be reported as zero accuracy.
 */
export function summarizeInventory(data: ExtractClaimsV2Data) {
  const canonical = data.claims.filter((claim) => claim.duplicateOfClaimId === null);
  const eligible = canonical.filter(
    (claim) => claim.coverageDisposition === "factual_claim" && claim.checkability === "checkable",
  );
  const deferred = canonical.filter((claim) => claim.coverageDisposition === "deferred");
  return {
    inventoriedClaims: canonical.length,
    duplicateClaims: data.claims.length - canonical.length,
    checkableClaims: eligible.length,
    needsContextClaims: canonical.filter((claim) => claim.checkability === "needs_context").length,
    deferredClaims: deferred.length,
    noCheckableClaims:
      canonical.length === 0 &&
      data.coverage.every((document) => document.extractionStatus === "complete"),
  };
}
