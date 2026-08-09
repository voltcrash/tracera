export { aggregateScore } from "./aggregate-score.js";
export { analyzeFraming, buildFramingPrompt } from "./analyze-framing.js";
export {
  buildClaimExtractionPrompt,
  extractClaims,
  type PromptAuditOptions,
} from "./extract-claims.js";
export { retrieveSources } from "./retrieve-sources.js";
export { buildVerdictPrompt, scoreClaim } from "./score-claim.js";
export { verifyText } from "./verify-text.js";
export { normalizeInput, type RawAnalysisInput } from "./normalize-input.js";
export { retrieveArchiveHistory, traceGroundZero } from "./ground-zero.js";
export type {
  ClaimVerdict,
  EvidenceSource,
  ExtractedClaim,
  Verdict,
  TraceraScore,
  VerifyTextOptions,
  NormalizedInput,
  GroundZeroResult,
  FramingAnalysis,
} from "./types.js";
