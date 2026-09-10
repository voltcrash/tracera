/*
 * Frozen v2 stage interfaces and ports.
 *
 * Core stage logic depends only on this module and on @repo/contracts/core-v2.
 * It must not import database globals, read process.env, or call fetch
 * directly: every side effect travels through a port on RunEnvironment, so a
 * fixture run needs no network, credentials or production database.
 */
import type {
  ClaimV2,
  CoreIssue,
  DocumentSnapshot,
  Decision,
  EvidenceAssessment,
  EvidenceCandidate,
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
} from "@repo/contracts/core-v2";
import type { z } from "zod";

export type { StageResult } from "@repo/contracts/core-v2";

export const CORE_V2_ENGINE_VERSION = "core-v2.0.0" as const;

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

export interface CorePorts {
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
  ports: CorePorts;
  signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Stage inputs and outputs
// ---------------------------------------------------------------------------

export type CoreInput =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string }
  | { kind: "image"; mimeType: string; data: string; caption: string | null };

export interface NormalizeInputV2Input {
  input: CoreInput;
}

export interface NormalizeInputV2Data {
  snapshots: DocumentSnapshot[];
  primarySnapshotId: string;
}

export interface ExtractClaimsV2Input {
  snapshots: DocumentSnapshot[];
  primarySnapshotId: string;
}

export interface ExtractClaimsV2Data {
  claims: ClaimV2[];
  coverage: InputCoverage[];
}

export interface RetrieveEvidenceV2Input {
  claims: ClaimV2[];
  snapshots: DocumentSnapshot[];
  /** Round 0 is the initial plan; later rounds answer sufficiency feedback. */
  round: number;
  sufficiency: SufficiencyFeedback[];
}

export interface RetrieveEvidenceV2Data {
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

export interface AssessEvidenceV2Input {
  claims: ClaimV2[];
  snapshots: DocumentSnapshot[];
  admittedSnapshotIds: string[];
}

export interface AssessEvidenceV2Data {
  assessments: EvidenceAssessment[];
  sufficiency: SufficiencyFeedback[];
}

export interface TraceOriginsV2Input {
  claims: ClaimV2[];
  snapshots: DocumentSnapshot[];
  assessments: EvidenceAssessment[];
}

export interface TraceOriginsV2Data {
  graphs: ProvenanceGraph[];
  /** Documents pulled during traversal still require assessment before use. */
  newSnapshotIds: string[];
}

export interface AdjudicateClaimsV2Input {
  claims: ClaimV2[];
  assessments: EvidenceAssessment[];
  graphs: ProvenanceGraph[];
}

export interface AdjudicateClaimsV2Data {
  /** Diagnostic decisions. Publishable labels are set by calibration. */
  decisions: Decision[];
}

export interface CalibrateDecisionsV2Input {
  claims: ClaimV2[];
  decisions: Decision[];
  assessments: EvidenceAssessment[];
}

export interface CalibrateDecisionsV2Data {
  decisions: Decision[];
}

export interface ScoreReportV2Input {
  claims: ClaimV2[];
  decisions: Decision[];
  assessments: EvidenceAssessment[];
  graphs: ProvenanceGraph[];
  coverage: InputCoverage[];
  inputStatus: Scorecard["inputStatus"];
  extractionStatus: Scorecard["extractionStatus"];
  /** Clock reading supplied by the orchestrator so scoring stays pure. */
  at: string;
}

export interface ScoreReportV2Data {
  scorecard: Scorecard;
  presentationFindings: PresentationFinding[];
}

export interface RunAnalysisV2Input {
  input: CoreInput;
  seed: number;
}

export interface RunAnalysisV2Result {
  status: RunStatus;
  report: RunReport | null;
  issues: CoreIssue[];
  replayManifest: ReplayManifest | null;
  cost: RunCostSummary;
}

// ---------------------------------------------------------------------------
// Frozen stage signatures
// ---------------------------------------------------------------------------

export type NormalizeInputV2 = (
  input: NormalizeInputV2Input,
  environment: RunEnvironment,
) => Promise<StageResult<NormalizeInputV2Data>>;

export type ExtractClaimsV2 = (
  input: ExtractClaimsV2Input,
  environment: RunEnvironment,
) => Promise<StageResult<ExtractClaimsV2Data>>;

export type RetrieveEvidenceV2 = (
  input: RetrieveEvidenceV2Input,
  environment: RunEnvironment,
) => Promise<StageResult<RetrieveEvidenceV2Data>>;

export type AssessEvidenceV2 = (
  input: AssessEvidenceV2Input,
  environment: RunEnvironment,
) => Promise<StageResult<AssessEvidenceV2Data>>;

export type TraceOriginsV2 = (
  input: TraceOriginsV2Input,
  environment: RunEnvironment,
) => Promise<StageResult<TraceOriginsV2Data>>;

export type AdjudicateClaimsV2 = (
  input: AdjudicateClaimsV2Input,
  environment: RunEnvironment,
) => Promise<StageResult<AdjudicateClaimsV2Data>>;

export type CalibrateDecisionsV2 = (
  input: CalibrateDecisionsV2Input,
  environment: RunEnvironment,
) => Promise<StageResult<CalibrateDecisionsV2Data>>;

/** Scoring is a pure versioned function: no ports, no clock, no model calls. */
export type ScoreReportV2 = (input: ScoreReportV2Input) => StageResult<ScoreReportV2Data>;

export type RunAnalysisV2 = (
  input: RunAnalysisV2Input,
  environment: RunEnvironment,
) => Promise<RunAnalysisV2Result>;
