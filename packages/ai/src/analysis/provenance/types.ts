import type { Claim, DocumentSnapshot, StageResult, TimeInterval } from "@repo/contracts/analysis";
import type { AssessEvidence, RetrieveEvidenceData, RunEnvironment } from "../types";
import type { RetrievalOptions } from "../retrieval/index";

export interface ProvenanceReference {
  url: string;
  type: "cites" | "attributes_to";
  locator: { snapshotId: string; span: { start: number; end: number }; quote: string };
}

export interface ProvenanceRetrievalController {
  retrieveReference(
    request: {
      claim: Claim;
      sourceSnapshot: DocumentSnapshot;
      snapshots: DocumentSnapshot[];
      reference: ProvenanceReference;
      hop: number;
      priorExternalRequests: number;
      priorCostUsd: number | null;
    },
    environment: RunEnvironment,
  ): Promise<StageResult<RetrieveEvidenceData>>;
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
  assessEvidence?: AssessEvidence;
  archive?: ArchiveLookupPort;
  priorExternalRequests?: number;
  priorCostUsd?: number | null;
}
