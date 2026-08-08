export type ClaimType = "factual_assertion" | "opinion" | "framing";
export type Checkability = "checkable" | "needs_context" | "not_checkable";
export type Verdict = "supported" | "contradicted" | "misleading" | "mixed" | "unverified";

export interface ExtractedClaim {
  id: string;
  claimText: string;
  claimType: ClaimType;
  checkability: Checkability;
  context: string;
}

export type EvidenceSourceType =
  | "corpus"
  | "google_fact_check"
  | "newsapi"
  | "gdelt"
  | "publisher_rss"
  | "google_news_rss"
  | "web_search";

export interface EvidenceSource {
  id: string;
  type: EvidenceSourceType;
  title: string;
  url?: string;
  publisher?: string;
  sourceDomain?: string | null;
  claimText?: string;
  verdict?: string | null;
  rating?: string | null;
  snippet?: string | null;
  publishedAt?: string | null;
  similarity?: number;
  credibility?: number;
}

export interface NormalizedInput {
  inputType: "text" | "link" | "image";
  text: string;
  rawInput: string;
  sourceUrl?: string;
  sourceDomain?: string;
  publishedAt?: string;
  author?: string;
  imageMetadata?: { mimeType?: string; reverseSearchUrl?: string; exif?: Record<string, string> };
}

export interface GroundZeroResult {
  status: "candidate" | "not_found";
  earliestSource: EvidenceSource | null;
  candidates: EvidenceSource[];
  explanation: string;
}

export interface ClaimVerdict {
  claim: ExtractedClaim;
  verdict: Verdict;
  confidence: number;
  reasoning: string[];
  consideredSources: EvidenceSource[];
  supportingSources: EvidenceSource[];
  contradictingSources: EvidenceSource[];
  sourceConflict: boolean;
  evidenceQuality: number;
}

export interface ScoreDimension {
  score: number;
  label: "strong" | "moderate" | "weak";
}

export interface TraceraScore {
  overall: number;
  factualAccuracy: ScoreDimension;
  sourceCorroboration: ScoreDimension;
  framingManipulation: ScoreDimension;
  evidenceQuality: ScoreDimension;
  sourceReputation: ScoreDimension;
  recency: {
    flag: "current" | "recent" | "aging" | "unknown";
    newestEvidenceAt: string | null;
  };
}

export interface VerifyTextOptions {
  provider: import("../provider.js").AiProvider;
  factCheckApiKey?: string;
  corpusSimilarityThreshold?: number;
  newsApiKey?: string;
  webSearchEndpoint?: string;
  webSearchApiKey?: string;
  /** Reuse a claim vector when the caller already generated it for persistence. */
  claimEmbedding?: number[];
}
