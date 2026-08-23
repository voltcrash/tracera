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
  | "submitted_source"
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
  publisherPublishedAt?: string | null;
  canonicalUrl?: string | null;
  citedUrls?: string[];
  similarity?: number;
  credibility?: number;
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

export type ClaimResult = ClaimVerdict;

export interface FramingAnalysis {
  emotionalLanguageLevel: number;
  factualSkewLevel: number;
  contextOmissionRisk: number;
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

export interface ImageMetadata {
  mimeType?: string;
  reverseSearchUrl?: string;
  exif?: Record<string, string>;
  ocrProvider?: "configured" | "model_fallback";
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
      | "chronology_conflict"
      | "archive_snapshot"
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
  archiveHistory: Array<{
    url: string;
    firstSeenAt: string;
    archivedUrl: string;
  }>;
}

export type AnalysisReuseState = "reused_exact" | "fresh" | "reanalyzed" | "scheduled_recheck";

export interface AnalysisReuse {
  state: AnalysisReuseState;
  expiresAt?: string;
  relatedContextClaims?: number;
  policyBand?: "breaking" | "developing" | "recent" | "established" | "unknown";
  nextReviewAt?: string;
  policy?: string;
}

export interface AnalysisResponse {
  cached: boolean;
  check: {
    id: string;
    createdAt: string;
    nextReviewAt?: string;
  };
  claims: ClaimResult[];
  traceraScore: TraceraScore;
  framingAnalysis?: FramingAnalysis;
  groundZero?: GroundZeroResult;
  inputMetadata?: ImageMetadata;
  reuse?: AnalysisReuse;
}

export interface AnalysisErrorResponse {
  error: string;
  code: "no_checkable_claims" | "analysis_unavailable";
}
