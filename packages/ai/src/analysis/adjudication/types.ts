import type {
  ClaimLabel,
  DecisionReasonCode,
  DocumentSnapshot,
  EvidenceAssessment,
  EvidenceCandidate,
} from "@repo/contracts/analysis";
import type { RetrievalOptions } from "../retrieval/index";
import type { AssessEvidence, RetrieveEvidence } from "../types";

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
  }) => RetrieveEvidence;
  /** Defaults to Task 07's assessment stage bounded by the remaining shared request cap. */
  createAssess?: (limits: { maxGenerationRequests: number }) => AssessEvidence;
  /**
   * Decisions may cite assessments produced by the targeted round, and the frozen
   * AdjudicateClaimsData has no field for them, so the orchestrator must persist
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
