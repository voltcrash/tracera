import type { EvidenceSource, ImageMetadata } from "@repo/contracts";

export type {
  Checkability,
  ClaimType,
  ClaimVerdict,
  EvidenceSource,
  EvidenceSourceType,
  ExtractedClaim,
  FramingAnalysis,
  GroundZeroResult,
  ScoreDimension,
  TraceraScore,
  Verdict,
} from "@repo/contracts";

export interface NormalizedInput {
  inputType: "text" | "link" | "image";
  text: string;
  rawInput: string;
  title?: string;
  sourceUrl?: string;
  sourceDomain?: string;
  publishedAt?: string;
  author?: string;
  imageMetadata?: ImageMetadata;
}

export interface VerifyTextOptions {
  provider: import("../provider.js").AiProvider;
  signal?: AbortSignal;
  factCheckApiKey?: string;
  corpusSimilarityThreshold?: number;
  newsApiKey?: string;
  webSearchEndpoint?: string;
  webSearchApiKey?: string;
  /** The surrounding story text used to keep short atomic claims on-topic. */
  storyContext?: string;
  /** The item being analyzed. It is context, not independent corroboration. */
  submittedSource?: EvidenceSource;
  /** Reuse a claim vector when the caller already generated it for persistence. */
  claimEmbedding?: number[];
}
