import type { ClaimV2, EvidenceAssessment, EvidenceRelation } from "@repo/contracts/core-v2";
import type { GenerationRequest } from "../types.js";

export interface EvidenceAssessmentOptions {
  maxPassagesPerSnapshot?: number;
  maxGenerationRequests?: number | null;
  deadlineMonotonicMs?: number | null;
}

export interface ChallengeInput {
  claim: ClaimV2;
  evidence: Array<
    Pick<
      EvidenceAssessment,
      | "id"
      | "snapshotId"
      | "excerpt"
      | "relation"
      | "applicability"
      | "directness"
      | "dependencyGroupId"
      | "dependence"
      | "justification"
    >
  >;
}

export interface RawAssessment {
  claimId: string;
  snapshotId: string;
  quote: string;
  relation: EvidenceRelation;
  applicability: EvidenceAssessment["applicability"];
  directness: EvidenceAssessment["directness"];
  justification: string;
}

export type EvidenceGenerationRequest = GenerationRequest<RawAssessment>;
