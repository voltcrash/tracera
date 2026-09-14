import type { ClaimV2, DocumentSnapshot, StageResult, TimeInterval } from "@repo/contracts/core-v2";
import type { AssessEvidenceV2, RetrieveEvidenceV2Data, RunEnvironment } from "../types.js";
import type { RetrievalOptions } from "../retrieval/index.js";

export interface ProvenanceReference {
  url: string;
  type: "cites" | "attributes_to";
  locator: { snapshotId: string; span: { start: number; end: number }; quote: string };
}

export interface ProvenanceRetrievalController {
  retrieveReference(
    request: {
      claim: ClaimV2;
      sourceSnapshot: DocumentSnapshot;
      snapshots: DocumentSnapshot[];
      reference: ProvenanceReference;
      hop: number;
      priorExternalRequests: number;
      priorCostUsd: number | null;
    },
    environment: RunEnvironment,
  ): Promise<StageResult<RetrieveEvidenceV2Data>>;
}

export interface ArchiveCaptureCandidate {
  captureUrl: string;
  originalUrl: string;
  observedAt: TimeInterval;
}

export interface ArchiveLookupPort {
  readonly provider: string;
  lookup(request: {
    claimId: string;
    url: string;
    asOfTime: string;
    signal: AbortSignal;
  }): Promise<StageResult<{ captures: ArchiveCaptureCandidate[] }>>;
}

export interface ProvenanceOptions {
  retrieval?: ProvenanceRetrievalController;
  retrievalOptions?: RetrievalOptions;
  assessEvidence?: AssessEvidenceV2;
  archive?: ArchiveLookupPort;
  priorExternalRequests?: number;
  priorCostUsd?: number | null;
}
