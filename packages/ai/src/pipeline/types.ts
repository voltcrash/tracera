export type ClaimType = "factual_assertion" | "opinion" | "framing";
export type Checkability = "checkable" | "needs_context" | "not_checkable";
export type Verdict =
  | "supported"
  | "contradicted"
  | "misleading"
  | "mixed"
  | "unverified";

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
  /** The publisher-declared date, preferred over a search-index timestamp. */
  publisherPublishedAt?: string | null;
  /** Canonical URL discovered in the publisher document, when available. */
  canonicalUrl?: string | null;
  /** Outbound source/citation URLs explicitly linked by the publisher. */
  citedUrls?: string[];
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
  imageMetadata?: {
    mimeType?: string;
    reverseSearchUrl?: string;
    exif?: Record<string, string>;
    ocrProvider?: "configured" | "model_fallback";
  };
}

export interface GroundZeroResult {
  status: "candidate" | "not_found" | "inconclusive";
  earliestSource: EvidenceSource | null;
  candidates: EvidenceSource[];
  confidence: "low" | "moderate" | "high";
  signals: string[];
  explanation: string;
  relationships: Array<{
    sourceId: string;
    relation:
      | "publisher"
      | "repost"
      | "cites_earlier_source"
      | "corpus_history";
    targetUrl?: string;
  }>;
  corpusHistory: Array<{
    checkId: string;
    sourceUrl?: string | null;
    sourceDomain?: string | null;
    publishedAt?: string | null;
    createdAt: string;
  }>;
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

export interface FramingAnalysis {
  /** 0 is neutral; 1 is highly emotionally manipulative. */
  emotionalLanguageLevel: number;
  /** 0 is factually balanced wording; 1 is severe presentation skew. */
  factualSkewLevel: number;
  contextOmissionRisk: number;
  /** Higher is better and feeds the nutrition-label score. */
  integrityScore: number;
  findings: string[];
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
