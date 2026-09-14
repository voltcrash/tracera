import type {
  ClaimLabel,
  DecisionReasonCode,
  DocumentSnapshot,
  EvidenceAssessment,
  EvidenceCandidate,
} from "@repo/contracts/core-v2";
import type { RetrievalOptions } from "../retrieval/index.js";
import type { AssessEvidenceV2, RetrieveEvidenceV2 } from "../types.js";

/** Evidence produced by the single targeted round; it must be persisted with the report. */
export interface TargetedEvidence {
  claimId: string;
  round: number;
  candidates: EvidenceCandidate[];
  snapshots: DocumentSnapshot[];
  admittedSnapshotIds: string[];
  assessments: EvidenceAssessment[];
}

export interface TargetedReassessment {
  retrievalOptions?: RetrievalOptions;
  /** Defaults to Task 06's controller charged with the run's prior usage. */
  createRetrieve?: (usage: {
    priorExternalRequests: number;
    priorCostUsd: number | null;
  }) => RetrieveEvidenceV2;
  /** Defaults to Task 07's assessment stage bounded by the remaining shared request cap. */
  createAssess?: (limits: { maxGenerationRequests: number }) => AssessEvidenceV2;
  /**
   * Decisions may cite assessments produced by the targeted round, and the frozen
   * AdjudicateClaimsV2Data has no field for them, so the orchestrator must persist
   * them before finalizing a report.
   */
  record(evidence: TargetedEvidence, signal: AbortSignal): Promise<void>;
}

export interface AdjudicationOptions {
  priorExternalRequests?: number;
  priorCostUsd?: number | null;
  /** Targeted retrieval rounds already consumed by retrieval before adjudication. */
  priorTargetedRounds?: number;
  targetedReassessment?: TargetedReassessment;
}

export interface DraftProposal {
  claimId: string;
  label: ClaimLabel;
  supportingAssessmentIds: string[];
  contradictingAssessmentIds: string[];
  correctiveContextAssessmentIds: string[];
  justification: string;
  selfConfidence: number | null;
}

export interface ChallengeProposal {
  claimId: string;
  label: ClaimLabel;
  citedAssessmentIds: string[];
  justification: string;
}

export interface EvidencePartition {
  usable: EvidenceAssessment[];
  integrityFailures: string[];
  exclusionReasons: Set<DecisionReasonCode>;
  needsHumanReview: number;
}
