import type {
  ClaimV2,
  DocumentSnapshot,
  EvidenceCandidate,
  QueryIntent,
  StageResult,
  TimeInterval,
} from "@repo/contracts/core-v2";
import type { SearchPort } from "../types";

export interface QueryTransformation {
  kind: "quoted" | "translated" | "sufficiency_suggestion";
  sourceText: string;
  outputText: string;
  language: string | null;
}

export interface RetrievalQuestion {
  claimId: string;
  question: string;
  query: string;
  intent: QueryIntent;
  dateRange: TimeInterval | null;
  transformations: QueryTransformation[];
}

export interface PrimarySourceResolverPort {
  readonly provider: string;
  resolve(request: {
    claim: ClaimV2;
    candidates: EvidenceCandidate[];
    limit: number;
    signal: AbortSignal;
  }): Promise<StageResult<{ candidates: EvidenceCandidate[] }>>;
}

export interface CorpusEvidenceMatch {
  snapshotId: string;
  contentHash: string;
  tenantId: string;
  ownerUserId: string;
  visibility: "private" | "unlisted" | "public";
  propositionKey: string;
  temporalScope: TimeInterval;
  retrieverVersion: string;
  sourceRunId: string;
}

export interface CorpusEvidencePort {
  find(request: {
    tenantId: string;
    ownerUserId: string;
    visibility: "private" | "unlisted" | "public";
    claim: ClaimV2;
    propositionKey: string;
    retrieverVersion: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<StageResult<{ matches: CorpusEvidenceMatch[] }>>;
}

export interface PassageCandidate {
  snapshotId: string;
  span: { start: number; end: number };
  text: string;
  lexicalScore: number;
  requiresAssessment: true;
}

export interface PassageRerankerPort {
  readonly provider: string;
  rerank(request: {
    claim: ClaimV2;
    passages: PassageCandidate[];
    limit: number;
    signal: AbortSignal;
  }): Promise<{ passages: PassageCandidate[]; costUsd: number | null }>;
}

export interface RetrievalOptions {
  priorExternalRequests?: number;
  priorCostUsd?: number | null;
  maxPassagesPerSnapshot?: number;
  maxPassagePoolPerClaim?: number;
  maxDocumentBytes?: number;
  primarySourceResolver?: PrimarySourceResolverPort;
  corpus?: CorpusEvidencePort;
  reranker?: PassageRerankerPort;
  searchPorts?: SearchPort[];
}

export interface RetrievalReplayCase {
  id: string;
  description: string;
  expected: {
    status: "complete" | "partial" | "unavailable" | "failed";
    stoppingReason: "plan_complete" | "budget_exhausted" | "no_results" | "provider_outage" | null;
    admittedUrls: string[];
    candidateOnlyUrls: string[];
  };
}

export type AcquiredEvidence = {
  candidate: EvidenceCandidate;
  snapshot: DocumentSnapshot;
  passages: PassageCandidate[];
};
