export { aggregateScore } from "./aggregate-score.js";
export { extractClaims } from "./extract-claims.js";
export { retrieveSources } from "./retrieve-sources.js";
export { scoreClaim } from "./score-claim.js";
export { verifyText } from "./verify-text.js";
export { normalizeInput, type RawAnalysisInput } from "./normalize-input.js";
export { traceGroundZero } from "./ground-zero.js";
export type {
  ClaimVerdict,
  EvidenceSource,
  ExtractedClaim,
  Verdict,
  TraceraScore,
  VerifyTextOptions,
  NormalizedInput,
  GroundZeroResult,
} from "./types.js";
