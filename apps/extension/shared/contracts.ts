export interface PageSnapshot {
  title: string;
  text: string;
  url: string;
}

export type Verdict =
  | "supported"
  | "contradicted"
  | "misleading"
  | "mixed"
  | "unverified";

export interface EvidenceSource {
  title: string;
  url?: string;
  publisher?: string;
}

export interface ClaimResult {
  claim: { claimText: string };
  verdict: Verdict;
  confidence: number;
  reasoning: string[];
  supportingSources: EvidenceSource[];
  contradictingSources: EvidenceSource[];
  evidenceQuality: number;
}

export interface ScoreDimension {
  score: number;
  label: string;
}

export interface AnalysisResponse {
  cached: boolean;
  check: { id: string; createdAt: string };
  claims: ClaimResult[];
  traceraScore: {
    overall: number;
    factualAccuracy: ScoreDimension;
    sourceCorroboration: ScoreDimension;
    framingManipulation: ScoreDimension;
    evidenceQuality: ScoreDimension;
    sourceReputation: ScoreDimension;
  };
  groundZero?: {
    earliestSource: EvidenceSource | null;
    explanation: string;
  };
}
