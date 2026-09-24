/*
 * Frozen v2 stage interfaces and ports.
 *
 * Core stage logic depends only on this module and on @repo/contracts/analysis.
 * It must not import database globals, read process.env, or call fetch
 * directly: every side effect travels through a port on RunEnvironment, so a
 * fixture run needs no network, credentials or production database.
 */
import type {
  Claim,
  AnalysisIssue,
  DocumentSnapshot,
  Decision,
  EvidenceAssessment,
  EvidenceCandidate,
  FocusedPublicationPolicy,
  FocusedSelection,
  InputCoverage,
  PresentationFinding,
  ProvenanceGraph,
  QueryIntent,
  ReplayManifest,
  RunContext,
  RunCostSummary,
  RunReport,
  RunStatus,
  Scorecard,
  StageResult,
  SufficiencyFeedback,
  TimeInterval,
} from "@repo/contracts/analysis";
import type { z } from "zod";

export type { StageResult } from "@repo/contracts/analysis";

export const ANALYSIS_ENGINE_VERSION = "core-v2.0.0" as const;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface PortUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface GenerationRequest<Value> {
  /** Stable name used for audit records and replay manifests. */
  schemaName: string;
  schema: z.ZodType<Value>;
  system: string;
  prompt: string;
  /** Untrusted document text is data. It never becomes an instruction. */
  untrustedContent: Array<{ label: string; text: string }>;
  images: Array<{ mimeType: string; data: string }>;
  maxOutputTokens: number | null;
  signal: AbortSignal;
}

export interface GenerationPort {
  readonly modelId: string;
  readonly promptVersion: string;
  generate<Value>(
    request: GenerationRequest<Value>,
  ): Promise<{ value: Value; usage: PortUsage; attempts: number }>;
}

export interface EmbeddingPort {
  readonly modelId: string;
  readonly dimensions: number;
  readonly preprocessing: string;
  embed(request: {
    texts: string[];
    signal: AbortSignal;
  }): Promise<{ vectors: number[][]; usage: PortUsage }>;
}

export interface SearchRequest {
  query: string;
  intent: QueryIntent;
  claimId: string;
  limit: number;
  dateRange: TimeInterval | null;
  signal: AbortSignal;
}

export interface SearchPort {
  readonly provider: string;
  readonly supportsDateRange: boolean;
  search(request: SearchRequest): Promise<StageResult<{ candidates: EvidenceCandidate[] }>>;
}

export interface DocumentAcquisitionPort {
  /** Returns an immutable snapshot, or an explicit unavailable/failed status. */
  acquire(request: {
    url: string;
    role: DocumentSnapshot["role"];
    maxBytes: number;
    signal: AbortSignal;
  }): Promise<StageResult<{ snapshot: DocumentSnapshot }>>;
  acquireFromText(request: {
    text: string;
    role: DocumentSnapshot["role"];
    signal: AbortSignal;
  }): Promise<StageResult<{ snapshot: DocumentSnapshot }>>;
}

export interface SnapshotStorePort {
  put(snapshot: DocumentSnapshot, signal: AbortSignal): Promise<void>;
  get(id: string, signal: AbortSignal): Promise<DocumentSnapshot | null>;
  getMany(ids: string[], signal: AbortSignal): Promise<DocumentSnapshot[]>;
}

export interface RunStorePort {
  checkpoint(request: {
    runId: string;
    stage: RunReport["stageOutcomes"][number]["stage"];
    attempt: number;
    fencingToken: string;
    checkpointHash: string;
    payloadJson: string;
    signal: AbortSignal;
  }): Promise<void>;
  readCheckpoint(request: {
    runId: string;
    stage: RunReport["stageOutcomes"][number]["stage"];
    signal: AbortSignal;
  }): Promise<{ checkpointHash: string; payloadJson: string } | null>;
  finalize(request: {
    runId: string;
    fencingToken: string;
    report: RunReport;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface ClockPort {
  /** ISO-8601 with offset. The only source of time in core stage logic. */
  now(): string;
  monotonicMs(): number;
}

export interface AuditEvent {
  runId: string;
  stage: RunReport["stageOutcomes"][number]["stage"] | "run";
  kind:
    | "stage_started"
    | "stage_finished"
    | "external_request"
    | "budget_consumed"
    | "validation_rejected"
    | "cancellation"
    | "decision_gated";
  message: string;
  claimId: string | null;
  snapshotId: string | null;
  at: string;
}

export interface AuditPort {
  readonly sinkId: string;
  record(event: AuditEvent): Promise<void>;
}

export interface AnalysisPorts {
  generation: GenerationPort;
  embeddings: EmbeddingPort;
  search: SearchPort[];
  documents: DocumentAcquisitionPort;
  snapshots: SnapshotStorePort;
  runs: RunStorePort;
  clock: ClockPort;
  audit: AuditPort;
}

/** Everything a stage may touch. Nothing else is in scope for core logic. */
export interface RunEnvironment {
  context: RunContext;
  ports: AnalysisPorts;
  signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Stage inputs and outputs
// ---------------------------------------------------------------------------

export type RunInput =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string }
  | { kind: "image"; mimeType: string; data: string; caption: string | null };

export interface NormalizeInputInput {
  input: RunInput;
}

export interface NormalizeInputData {
  snapshots: DocumentSnapshot[];
  primarySnapshotId: string;
}

export interface ExtractClaimsInput {
  snapshots: DocumentSnapshot[];
  primarySnapshotId: string;
}

export interface ExtractClaimsData {
  claims: Claim[];
  coverage: InputCoverage[];
}

export interface RetrieveEvidenceInput {
  claims: Claim[];
  snapshots: DocumentSnapshot[];
  /** Round 0 is the initial plan; later rounds answer sufficiency feedback. */
  round: number;
  sufficiency: SufficiencyFeedback[];
}

export interface RetrieveEvidenceData {
  candidates: EvidenceCandidate[];
  snapshots: DocumentSnapshot[];
  admittedSnapshotIds: string[];
  budgetUsed: { externalRequests: number; costUsd: number | null };
  stoppingReason:
    | "plan_complete"
    | "budget_exhausted"
    | "no_results"
    | "provider_outage"
    | "canceled";
}

export interface AssessEvidenceInput {
  claims: Claim[];
  snapshots: DocumentSnapshot[];
  admittedSnapshotIds: string[];
}

export interface AssessEvidenceData {
  assessments: EvidenceAssessment[];
  sufficiency: SufficiencyFeedback[];
}

export interface TraceOriginsInput {
  claims: Claim[];
  snapshots: DocumentSnapshot[];
  assessments: EvidenceAssessment[];
}

export interface TraceOriginsData {
  graphs: ProvenanceGraph[];
  /** Documents pulled during traversal still require assessment before use. */
  newSnapshotIds: string[];
}

export interface AdjudicateClaimsInput {
  claims: Claim[];
  assessments: EvidenceAssessment[];
  graphs: ProvenanceGraph[];
}

export interface AdjudicateClaimsData {
  /** Diagnostic decisions. The focused publication boundary sets released labels. */
  decisions: Decision[];
}

export interface FocusedPublicationInput {
  claims: Claim[];
  snapshots: DocumentSnapshot[];
  decisions: Decision[];
  assessments: EvidenceAssessment[];
}

export interface FocusedPublicationData {
  policy: FocusedPublicationPolicy;
  decisions: Decision[];
}

export interface ScoreReportInput {
  claims: Claim[];
  decisions: Decision[];
  assessments: EvidenceAssessment[];
  graphs: ProvenanceGraph[];
  coverage: InputCoverage[];
  /** Immutable snapshots let scoring re-check exact citation offsets. */
  snapshots: DocumentSnapshot[];
  focusedSelection: FocusedSelection;
  inputStatus: Scorecard["inputStatus"];
  extractionStatus: Scorecard["extractionStatus"];
  /** Clock reading supplied by the orchestrator so scoring stays pure. */
  at: string;
}

export interface ScoreReportData {
  scorecard: Scorecard;
  presentationFindings: PresentationFinding[];
}

export interface RunAnalysisInput {
  input: RunInput;
  seed: number;
}

export interface RunAnalysisResult {
  status: RunStatus;
  report: RunReport | null;
  issues: AnalysisIssue[];
  replayManifest: ReplayManifest | null;
  cost: RunCostSummary;
}

// ---------------------------------------------------------------------------
// Frozen stage signatures
// ---------------------------------------------------------------------------

export type NormalizeInput = (
  input: NormalizeInputInput,
  environment: RunEnvironment,
) => Promise<StageResult<NormalizeInputData>>;

export type ExtractClaims = (
  input: ExtractClaimsInput,
  environment: RunEnvironment,
) => Promise<StageResult<ExtractClaimsData>>;

export type RetrieveEvidence = (
  input: RetrieveEvidenceInput,
  environment: RunEnvironment,
) => Promise<StageResult<RetrieveEvidenceData>>;

export type AssessEvidence = (
  input: AssessEvidenceInput,
  environment: RunEnvironment,
) => Promise<StageResult<AssessEvidenceData>>;

export type TraceOrigins = (
  input: TraceOriginsInput,
  environment: RunEnvironment,
) => Promise<StageResult<TraceOriginsData>>;

export type AdjudicateClaims = (
  input: AdjudicateClaimsInput,
  environment: RunEnvironment,
) => Promise<StageResult<AdjudicateClaimsData>>;

/** Focused publication is a pure local evidence gate; it never calls a provider. */
export type FocusedPublication = (
  input: FocusedPublicationInput,
  environment: RunEnvironment,
) => Promise<StageResult<FocusedPublicationData>>;

/** Scoring is a pure versioned function: no ports, no clock, no model calls. */
export type ScoreReport = (input: ScoreReportInput) => StageResult<ScoreReportData>;

export type RunAnalysis = (
  input: RunAnalysisInput,
  environment: RunEnvironment,
) => Promise<RunAnalysisResult>;
