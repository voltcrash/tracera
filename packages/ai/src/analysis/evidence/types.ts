import type { Claim, EvidenceAssessment, EvidenceRelation } from "@repo/contracts/analysis";
import type { GenerationRequest } from "../types";

export interface EvidenceAssessmentOptions {
  maxPassagesPerSnapshot?: number;
  maxGenerationRequests?: number | null;
  deadlineMonotonicMs?: number | null;
}

export interface ChallengeInput {
  claim: Claim;
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
