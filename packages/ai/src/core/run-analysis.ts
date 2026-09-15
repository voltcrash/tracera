import {
  CORE_V2_CONTRACT_VERSION,
  CORE_V2_SCHEMA_VERSION,
  issueSchema,
  runReportSchema,
  type CoreIssue,
  type Decision,
  type DocumentSnapshot,
  type EvidenceAssessment,
  type EvidenceCandidate,
  type InputCoverage,
  type ProvenanceGraph,
  type RunReport,
  type RunStatus,
  type StageMetrics,
  type StageName,
  type StageOutcome,
  type StageResult,
  type StageStatus,
} from "@repo/contracts/core-v2";
import { createAdjudicateClaimsV2, type TargetedEvidence } from "./adjudication/index.js";
import { createCalibrateDecisionsV2 } from "./calibration/index.js";
import { createExtractClaimsV2 } from "./claims/index.js";
import { createAssessEvidenceV2 } from "./evidence/index.js";
import { canonicalJson, evidenceSetHash, hashValue, snapshotIdentity } from "./hashing.js";
import { normalizeInputV2 } from "./ingestion/index.js";
import { createTraceOriginsV2, type ArchiveLookupPort } from "./provenance/index.js";
import { createRetrieveEvidenceV2, type RetrievalOptions } from "./retrieval/index.js";
import {
  decideReportReuse,
  propositionScopeHash,
  type ReportReuseLookup,
  type ReuseDecision,
} from "./reuse-policy.js";
import { scoreReportV2 } from "./scoring/index.js";
import type {
  AdjudicateClaimsV2,
  AssessEvidenceV2,
  AssessEvidenceV2Data,
  CalibrateDecisionsV2,
  ExtractClaimsV2,
  NormalizeInputV2,
  RetrieveEvidenceV2,
  RetrieveEvidenceV2Data,
  RunAnalysisV2,
  RunAnalysisV2Input,
  RunAnalysisV2Result,
  RunEnvironment,
  ScoreReportV2,
  TraceOriginsV2,
} from "./types.js";
import { CORE_V2_ENGINE_VERSION } from "./types.js";

export { canonicalJson, hashValue } from "./hashing.js";

/** Shared run allowance handed to each stage so no stage can spend the whole budget again. */
export interface StageUsage {
  priorExternalRequests: number;
  priorCostUsd: number | null;
  remainingExternalRequests: number;
  deadlineMonotonicMs: number;
  priorTargetedRounds: number;
}

export interface RunAnalysisV2StageFactories {
  normalizeInput(usage: StageUsage): NormalizeInputV2;
  extractClaims(usage: StageUsage): ExtractClaimsV2;
  retrieveEvidence(usage: StageUsage): RetrieveEvidenceV2;
  assessEvidence(usage: StageUsage): AssessEvidenceV2;
  traceOrigins(usage: StageUsage): TraceOriginsV2;
  adjudicateClaims(
    usage: StageUsage & {
      record: (evidence: TargetedEvidence, signal: AbortSignal) => Promise<void>;
    },
  ): AdjudicateClaimsV2;
  calibrateDecisions(usage: StageUsage): CalibrateDecisionsV2;
  scoreReport(usage: StageUsage): ScoreReportV2;
}

export interface RunAnalysisV2Options {
  /** Lease identity. Checkpoints are read and written only when both are supplied. */
  attempt?: number;
  fencingToken?: string;
  stages?: Partial<RunAnalysisV2StageFactories>;
  retrieval?: Omit<RetrievalOptions, "priorExternalRequests" | "priorCostUsd">;
  archive?: ArchiveLookupPort;
  calibratorArtifact?: unknown;
  reuse?: ReportReuseLookup;
}

interface RunState {
  snapshots: DocumentSnapshot[];
  primarySnapshotId: string | null;
  claims: RunReport["claims"];
  candidates: EvidenceCandidate[];
  admittedSnapshotIds: string[];
  assessments: EvidenceAssessment[];
  provenance: ProvenanceGraph[];
  decisions: Decision[];
  inputCoverage: InputCoverage[];
  outcomes: StageOutcome[];
  issues: CoreIssue[];
  evidenceSetHash: string | null;
  targetedRounds: number;
}

interface CheckpointEnvelope<Value, Extra> {
  version: 2;
  result: StageResult<Value>;
  extra: Extra;
}

interface Checkpointing {
  attempt: number;
  fencingToken: string;
}

interface AssessmentExtra {
  targetedRetrieval: StageResult<RetrieveEvidenceV2Data> | null;
  rounds: number;
}

interface ProvenanceExtra {
  snapshots: DocumentSnapshot[];
  reassessment: StageResult<AssessEvidenceV2Data>;
}

const STATUS_RANK: Record<StageStatus, number> = {
  complete: 0,
  partial: 1,
  unavailable: 2,
  failed: 3,
};

export function createRunAnalysisV2(options: RunAnalysisV2Options = {}): RunAnalysisV2 {
  const checkpointing = checkpointIdentity(options);
  const factories: RunAnalysisV2StageFactories = {
    ...defaultStageFactories(options),
    ...options.stages,
  };

  return async (input, environment) => {
    const { clock } = environment.ports;
    const startedMs = clock.monotonicMs();
    const deadlineMonotonicMs = startedMs + environment.context.budget.maxElapsedMs;
    const state = emptyState();
    const identity = runIdentity(environment);
    const usage = (pending: StageMetrics[] = []): StageUsage => {
      const metrics = [...state.outcomes.map(({ metrics }) => metrics), ...pending];
      const priorExternalRequests = metrics.reduce((sum, item) => sum + item.externalRequests, 0);
      return {
        priorExternalRequests,
        priorCostUsd: sumNullable(metrics.map(({ costUsd }) => costUsd)),
        remainingExternalRequests: Math.max(
          0,
          environment.context.budget.maxExternalRequests - priorExternalRequests,
        ),
        deadlineMonotonicMs,
        priorTargetedRounds: state.targetedRounds,
      };
    };
    const stop = (status: RunStatus) =>
      finishResult(status, input, environment, state, startedMs, null);
    const checkpointed = <Value, Extra>(
      stage: StageName,
      dependencyHash: string,
      execute: () => Promise<{ result: StageResult<Value>; extra: Extra }>,
    ) => executeStage(stage, dependencyHash, execute, environment, checkpointing);
    const interrupted = (stage: StageName): RunAnalysisV2Result | null => {
      if (canceled(environment)) {
        state.issues.push(issue("cancellation_requested", `The run was canceled before ${stage}.`));
        return stop("canceled");
      }
      if (clock.monotonicMs() >= deadlineMonotonicMs) {
        state.issues.push(issue("timeout", `The elapsed run cap was reached before ${stage}.`));
        return stop(state.outcomes.length === 0 ? "failed" : "partial");
      }
      return null;
    };

    const beforeNormalize = interrupted("normalize_input");
    if (beforeNormalize) return beforeNormalize;
    const normalized = await checkpointed(
      "normalize_input",
      hashValue({ input, identity }),
      async () => ({
        result: await factories.normalizeInput(usage())({ input: input.input }, environment),
        extra: null,
      }),
    );
    setOutcome(state, "normalize_input", normalized.result);
    if (!normalized.result.data) return stop(stageRunStatus(normalized.result));
    state.snapshots = uniqueById(normalized.result.data.snapshots);
    state.primarySnapshotId = normalized.result.data.primarySnapshotId;
    const primarySnapshotId = normalized.result.data.primarySnapshotId;

    const beforeExtract = interrupted("extract_claims");
    if (beforeExtract) return beforeExtract;
    const extracted = await checkpointed(
      "extract_claims",
      hashValue({ upstream: normalized.result, identity }),
      async () => ({
        result: await factories.extractClaims(usage())(
          { snapshots: state.snapshots, primarySnapshotId },
          environment,
        ),
        extra: null,
      }),
    );
    setOutcome(state, "extract_claims", extracted.result);
    if (!extracted.result.data) return stop(stageRunStatus(extracted.result));
    state.claims = extracted.result.data.claims;
    state.inputCoverage = extracted.result.data.coverage;

    if (
      options.reuse &&
      normalized.result.status === "complete" &&
      extracted.result.status === "complete"
    ) {
      const decision = await reuseDecision(options.reuse, environment, state);
      await environment.ports.audit.record({
        runId: environment.context.runId,
        stage: "run",
        kind: "stage_finished",
        message: decision.reusable
          ? `Reused compatible report ${decision.report.runId}.`
          : `Report reuse declined: ${decision.reason}.`,
        claimId: null,
        snapshotId: primarySnapshotId,
        at: clock.now(),
      });
      if (decision.reusable) return reusedResult(decision.report, environment, state, startedMs);
    }

    const beforeRetrieve = interrupted("retrieve_evidence");
    if (beforeRetrieve) return beforeRetrieve;
    const retrieved = await checkpointed(
      "retrieve_evidence",
      hashValue({ upstream: extracted.result, identity }),
      async () => ({
        result: await factories.retrieveEvidence(usage())(
          { claims: state.claims, snapshots: state.snapshots, round: 0, sufficiency: [] },
          environment,
        ),
        extra: null,
      }),
    );
    setOutcome(state, "retrieve_evidence", retrieved.result);
    if (!retrieved.result.data) return stop(stageRunStatus(retrieved.result));
    absorbRetrieval(state, retrieved.result.data);

    const beforeAssess = interrupted("assess_evidence");
    if (beforeAssess) return beforeAssess;
    const assessed = await checkpointed<AssessEvidenceV2Data, AssessmentExtra>(
      "assess_evidence",
      hashValue({
        upstream: retrieved.result,
        snapshots: snapshotIdentity(state.snapshots),
        identity,
      }),
      async () => {
        let assessment = await factories.assessEvidence(usage())(
          {
            claims: state.claims,
            snapshots: state.snapshots,
            admittedSnapshotIds: state.admittedSnapshotIds,
          },
          environment,
        );
        let targetedRetrieval: StageResult<RetrieveEvidenceV2Data> | null = null;
        let snapshots = state.snapshots;
        const assessedSnapshotIds = new Set(state.admittedSnapshotIds);
        const allowedRounds = Math.max(
          0,
          environment.context.budget.maxTargetedRetrievalRounds - 1,
        );
        let rounds = 0;
        while (assessment.data && rounds < allowedRounds && !canceled(environment)) {
          const insufficient = assessment.data.sufficiency.filter(({ sufficient }) => !sufficient);
          if (insufficient.length === 0) break;
          const pending: StageMetrics[] = [
            assessment.metrics,
            ...(targetedRetrieval ? [targetedRetrieval.metrics] : []),
          ];
          rounds += 1;
          const retrieval: StageResult<RetrieveEvidenceV2Data> = await factories.retrieveEvidence(
            usage(pending),
          )(
            { claims: state.claims, snapshots, round: rounds, sufficiency: insufficient },
            environment,
          );
          targetedRetrieval = targetedRetrieval
            ? mergeResults(targetedRetrieval, retrieval, combineRetrieval)
            : retrieval;
          if (!retrieval.data) break;
          snapshots = uniqueById([...snapshots, ...retrieval.data.snapshots]);
          const fresh = [...new Set(retrieval.data.admittedSnapshotIds)].filter(
            (id) => !assessedSnapshotIds.has(id),
          );
          if (fresh.length === 0) break;
          for (const id of fresh) assessedSnapshotIds.add(id);
          const reassessed = await factories.assessEvidence(usage([...pending, retrieval.metrics]))(
            { claims: state.claims, snapshots, admittedSnapshotIds: fresh },
            environment,
          );
          assessment = mergeResults(assessment, reassessed, combineAssessment);
        }
        return { result: assessment, extra: { targetedRetrieval, rounds } };
      },
    );
    if (assessed.extra.targetedRetrieval) {
      setOutcome(
        state,
        "retrieve_evidence",
        mergeResults(retrieved.result, assessed.extra.targetedRetrieval, combineRetrieval),
      );
      if (assessed.extra.targetedRetrieval.data)
        absorbRetrieval(state, assessed.extra.targetedRetrieval.data);
    }
    state.targetedRounds = assessed.extra.rounds;
    setOutcome(state, "assess_evidence", assessed.result);
    if (!assessed.result.data) return stop(stageRunStatus(assessed.result));
    state.assessments = uniqueById(assessed.result.data.assessments);
    state.evidenceSetHash = evidenceSetHash(state.snapshots, state.assessments);

    const beforeTrace = interrupted("trace_origins");
    if (beforeTrace) return beforeTrace;
    const traced = await checkpointed<
      { graphs: ProvenanceGraph[]; newSnapshotIds: string[] },
      ProvenanceExtra | null
    >(
      "trace_origins",
      hashValue({
        upstream: assessed.result,
        evidenceSetHash: state.evidenceSetHash,
        identity,
      }),
      async () => {
        const result = await factories.traceOrigins(usage())(
          { claims: state.claims, snapshots: state.snapshots, assessments: state.assessments },
          environment,
        );
        const newSnapshotIds = [...new Set(result.data?.newSnapshotIds ?? [])];
        if (!result.data || newSnapshotIds.length === 0) return { result, extra: null };
        const loaded = await environment.ports.snapshots.getMany(
          newSnapshotIds,
          environment.signal,
        );
        if (new Set(loaded.map(({ id }) => id)).size !== newSnapshotIds.length) {
          return {
            result: {
              status: "failed" as const,
              data: null,
              issues: [
                ...result.issues,
                issue(
                  "snapshot_unavailable",
                  "A provenance snapshot could not be loaded for mandatory reassessment.",
                ),
              ],
              metrics: result.metrics,
            },
            extra: null,
          };
        }
        const reassessment = await factories.assessEvidence(usage([result.metrics]))(
          {
            claims: state.claims,
            snapshots: uniqueById([...state.snapshots, ...loaded]),
            admittedSnapshotIds: newSnapshotIds,
          },
          environment,
        );
        return { result, extra: { snapshots: loaded, reassessment } };
      },
    );
    if (!traced.result.data) {
      setOutcome(state, "trace_origins", traced.result);
      return stop(stageRunStatus(traced.result));
    }
    state.provenance = traced.result.data.graphs;
    if (traced.extra) {
      const { reassessment } = traced.extra;
      setOutcome(state, "trace_origins", absorbOutcome(traced.result, reassessment));
      if (!reassessment.data) return stop(stageRunStatus(reassessment));
      state.snapshots = uniqueById([...state.snapshots, ...traced.extra.snapshots]);
      state.assessments = uniqueById([...state.assessments, ...reassessment.data.assessments]);
      state.evidenceSetHash = evidenceSetHash(state.snapshots, state.assessments);
    } else {
      setOutcome(state, "trace_origins", traced.result);
    }

    const beforeAdjudicate = interrupted("adjudicate_claims");
    if (beforeAdjudicate) return beforeAdjudicate;
    const adjudicated = await checkpointed<{ decisions: Decision[] }, TargetedEvidence[]>(
      "adjudicate_claims",
      hashValue({
        upstream: traced.result,
        reassessment: traced.extra?.reassessment ?? null,
        evidenceSetHash: state.evidenceSetHash,
        targetedRounds: state.targetedRounds,
        identity,
      }),
      async () => {
        const targeted: TargetedEvidence[] = [];
        const record = async (evidence: TargetedEvidence, signal: AbortSignal) => {
          signal.throwIfAborted();
          for (const snapshot of evidence.snapshots)
            await environment.ports.snapshots.put(snapshot, signal);
          targeted.push(evidence);
        };
        const result = await factories.adjudicateClaims({ ...usage(), record })(
          { claims: state.claims, assessments: state.assessments, graphs: state.provenance },
          environment,
        );
        return { result, extra: targeted };
      },
    );
    for (const evidence of adjudicated.extra) {
      state.candidates = uniqueById([...state.candidates, ...evidence.candidates]);
      state.snapshots = uniqueById([...state.snapshots, ...evidence.snapshots]);
      state.assessments = uniqueById([...state.assessments, ...evidence.assessments]);
      state.admittedSnapshotIds = [
        ...new Set([...state.admittedSnapshotIds, ...evidence.admittedSnapshotIds]),
      ];
    }
    if (adjudicated.extra.length > 0)
      state.evidenceSetHash = evidenceSetHash(state.snapshots, state.assessments);
    setOutcome(state, "adjudicate_claims", adjudicated.result);
    if (!adjudicated.result.data) return stop(stageRunStatus(adjudicated.result));
    state.decisions = adjudicated.result.data.decisions;

    const beforeCalibrate = interrupted("calibrate_decisions");
    if (beforeCalibrate) return beforeCalibrate;
    const calibrated = await checkpointed(
      "calibrate_decisions",
      hashValue({
        upstream: adjudicated.result,
        evidenceSetHash: state.evidenceSetHash,
        identity,
      }),
      async () => ({
        result: await factories.calibrateDecisions(usage())(
          { claims: state.claims, decisions: state.decisions, assessments: state.assessments },
          environment,
        ),
        extra: null,
      }),
    );
    setOutcome(state, "calibrate_decisions", calibrated.result);
    if (!calibrated.result.data) return stop(stageRunStatus(calibrated.result));
    state.decisions = calibrated.result.data.decisions;

    const beforeScore = interrupted("score_report");
    if (beforeScore) return beforeScore;
    const scored = await checkpointed(
      "score_report",
      hashValue({
        upstream: calibrated.result,
        evidenceSetHash: state.evidenceSetHash,
        identity,
      }),
      async () => ({
        result: factories.scoreReport(usage())({
          claims: state.claims,
          decisions: state.decisions,
          assessments: state.assessments,
          graphs: state.provenance,
          coverage: state.inputCoverage,
          inputStatus: normalized.result.status,
          extractionStatus: extracted.result.status,
          at: clock.now(),
        }),
        extra: null,
      }),
    );
    setOutcome(state, "score_report", scored.result);
    if (!scored.result.data) return stop(stageRunStatus(scored.result));
    if (canceled(environment)) return stop("canceled");
    return finishResult(
      overallStatus(state.outcomes),
      input,
      environment,
      state,
      startedMs,
      scored.result.data.scorecard,
    );
  };
}

export const runAnalysisV2: RunAnalysisV2 = createRunAnalysisV2();

export interface DeterministicReplayResult {
  mode: "deterministic_replay";
  sourceRunId: string;
  evidenceSetHash: string;
  evidenceSetHashVerified: true;
  decisionsMatch: boolean;
  scorecardMatch: boolean;
  report: RunReport;
}

/**
 * Recomputes calibration and scoring from persisted immutable artifacts only. It never
 * calls a model, search, or acquisition port; a stochastic rerun is a new durable run.
 */
export async function replayAnalysisV2(input: {
  report: RunReport;
  environment: RunEnvironment;
  calibrateDecisions: CalibrateDecisionsV2;
  scoreReport?: ScoreReportV2;
}): Promise<DeterministicReplayResult> {
  const source = runReportSchema.parse(input.report);
  const { environment } = input;
  if (environment.context.executionMode !== "replay")
    throw new Error("Deterministic replay requires executionMode replay.");
  environment.signal.throwIfAborted();
  const adjudication = source.stageOutcomes.find(({ stage }) => stage === "adjudicate_claims");
  if (
    source.evidenceSetHash === null ||
    !adjudication ||
    (adjudication.status !== "complete" && adjudication.status !== "partial")
  ) {
    throw new Error("The persisted run stopped before adjudication and cannot be replayed.");
  }
  const recomputed = evidenceSetHash(source.snapshots, source.assessments);
  if (recomputed !== source.evidenceSetHash) {
    throw new Error("Persisted evidence does not match the report's evidence-set hash.");
  }
  const calibrated = await input.calibrateDecisions(
    { claims: source.claims, decisions: source.decisions, assessments: source.assessments },
    environment,
  );
  if (!calibrated.data)
    throw new Error("Deterministic replay could not calibrate persisted decisions.");
  const score = (input.scoreReport ?? scoreReportV2)({
    claims: source.claims,
    decisions: calibrated.data.decisions,
    assessments: source.assessments,
    graphs: source.provenance,
    coverage: source.inputCoverage,
    inputStatus: source.scorecard?.inputStatus ?? stageStatus(source, "normalize_input"),
    extractionStatus: source.scorecard?.extractionStatus ?? stageStatus(source, "extract_claims"),
    at: environment.ports.clock.now(),
  });
  if (!score.data) throw new Error("Deterministic replay could not score persisted artifacts.");
  const retained = source.stageOutcomes.filter(
    ({ stage }) => stage !== "calibrate_decisions" && stage !== "score_report",
  );
  const stageOutcomes = [
    ...retained,
    outcome("calibrate_decisions", calibrated),
    outcome("score_report", score),
  ];
  const report = runReportSchema.parse({
    ...source,
    createdAt: environment.ports.clock.now(),
    status: overallStatus(stageOutcomes),
    stageOutcomes,
    decisions: calibrated.data.decisions,
    scorecard: score.data.scorecard,
    unresolvedReasons: uniqueIssues([
      ...source.unresolvedReasons,
      ...calibrated.issues,
      ...score.issues,
    ]),
  });
  return {
    mode: "deterministic_replay",
    sourceRunId: source.runId,
    evidenceSetHash: recomputed,
    evidenceSetHashVerified: true,
    decisionsMatch: canonicalJson(report.decisions) === canonicalJson(source.decisions),
    scorecardMatch: canonicalJson(report.scorecard) === canonicalJson(source.scorecard),
    report,
  };
}

function defaultStageFactories(options: RunAnalysisV2Options): RunAnalysisV2StageFactories {
  return {
    normalizeInput: () => normalizeInputV2,
    extractClaims: (usage) =>
      createExtractClaimsV2({
        maxGenerationRequests: usage.remainingExternalRequests,
        deadlineMonotonicMs: usage.deadlineMonotonicMs,
      }),
    retrieveEvidence: (usage) =>
      createRetrieveEvidenceV2({
        ...options.retrieval,
        priorExternalRequests: usage.priorExternalRequests,
        priorCostUsd: usage.priorCostUsd,
      }),
    assessEvidence: (usage) =>
      createAssessEvidenceV2({
        maxGenerationRequests: usage.remainingExternalRequests,
        deadlineMonotonicMs: usage.deadlineMonotonicMs,
      }),
    traceOrigins: (usage) =>
      createTraceOriginsV2({
        ...(options.retrieval ? { retrievalOptions: options.retrieval } : {}),
        ...(options.archive ? { archive: options.archive } : {}),
        priorExternalRequests: usage.priorExternalRequests,
        priorCostUsd: usage.priorCostUsd,
      }),
    adjudicateClaims: (usage) =>
      createAdjudicateClaimsV2({
        priorExternalRequests: usage.priorExternalRequests,
        priorCostUsd: usage.priorCostUsd,
        priorTargetedRounds: usage.priorTargetedRounds,
        targetedReassessment: {
          ...(options.retrieval ? { retrievalOptions: options.retrieval } : {}),
          record: usage.record,
        },
      }),
    calibrateDecisions: () =>
      createCalibrateDecisionsV2({ artifact: options.calibratorArtifact ?? null }),
    scoreReport: () => scoreReportV2,
  };
}

async function executeStage<Value, Extra>(
  stage: StageName,
  dependencyHash: string,
  execute: () => Promise<{ result: StageResult<Value>; extra: Extra }>,
  environment: RunEnvironment,
  checkpointing: Checkpointing | null,
): Promise<{ result: StageResult<Value>; extra: Extra }> {
  environment.signal.throwIfAborted();
  if (checkpointing) {
    const saved = await environment.ports.runs.readCheckpoint({
      runId: environment.context.runId,
      stage,
      signal: environment.signal,
    });
    if (saved?.checkpointHash === dependencyHash) {
      const envelope = JSON.parse(saved.payloadJson) as CheckpointEnvelope<Value, Extra>;
      if (envelope.version === 2 && isStageResult(envelope.result)) {
        return { result: envelope.result, extra: envelope.extra };
      }
    }
  }
  const executed = await execute();
  if (checkpointing && executed.result.status !== "failed" && !canceled(environment)) {
    await environment.ports.runs.checkpoint({
      runId: environment.context.runId,
      stage,
      attempt: checkpointing.attempt,
      fencingToken: checkpointing.fencingToken,
      checkpointHash: dependencyHash,
      payloadJson: JSON.stringify({
        version: 2,
        result: executed.result,
        extra: executed.extra,
      } satisfies CheckpointEnvelope<Value, Extra>),
      signal: environment.signal,
    });
  }
  return executed;
}

async function reuseDecision(
  lookup: ReportReuseLookup,
  environment: RunEnvironment,
  state: RunState,
): Promise<ReuseDecision> {
  const primary = state.snapshots.find(({ id }) => id === state.primarySnapshotId);
  if (!primary) return { reusable: false, report: null, reason: "no_candidate" };
  const candidate = await lookup.findCandidate({
    inputHash: environment.context.inputHash,
    contentHash: primary.contentHash,
    signal: environment.signal,
  });
  return decideReportReuse(candidate, {
    contentHash: primary.contentHash,
    propositionScopeHash: propositionScopeHash(state.claims),
    versions: environment.context.versions,
    visibility: environment.context.visibility,
    asOfTime: environment.context.asOfTime,
    maxAgeMs: lookup.maxAgeMs,
  });
}

/**
 * The reused report keeps the source replay manifest and as-of time, so its evidence stays
 * attributable to the run that acquired it; `replayManifest.runId` names that source run.
 */
function reusedResult(
  source: RunReport,
  environment: RunEnvironment,
  state: RunState,
  startedMs: number,
): RunAnalysisV2Result {
  const now = environment.ports.clock.now();
  const reusedOutcomes = source.stageOutcomes
    .filter(({ stage }) => stage !== "normalize_input" && stage !== "extract_claims")
    .map((item) => ({ ...item, metrics: zeroMetrics(now) }));
  const stageOutcomes = [...state.outcomes, ...reusedOutcomes];
  const cost = costSummary(state.outcomes, environment.ports.clock.monotonicMs() - startedMs);
  const report = runReportSchema.parse({
    ...source,
    runId: environment.context.runId,
    createdAt: now,
    engineVersion: CORE_V2_ENGINE_VERSION,
    status: overallStatus(stageOutcomes),
    stageOutcomes,
    snapshots: uniqueById([...source.snapshots, ...state.snapshots]),
    unresolvedReasons: uniqueIssues([...state.issues, ...source.unresolvedReasons]),
    cost,
  });
  return {
    status: report.status,
    report,
    issues: report.unresolvedReasons,
    replayManifest: report.replayManifest,
    cost,
  };
}

function finishResult(
  status: RunStatus,
  input: RunAnalysisV2Input,
  environment: RunEnvironment,
  state: RunState,
  startedMs: number,
  scorecard: RunReport["scorecard"],
): RunAnalysisV2Result {
  const replayManifest = {
    runId: environment.context.runId,
    versions: environment.context.versions,
    seed: input.seed,
    asOfTime: environment.context.asOfTime,
    inputHash: environment.context.inputHash,
    evidenceSetHash: state.evidenceSetHash,
    snapshotIds: state.snapshots.map(({ id }) => id).sort(),
    assessmentIds: state.assessments.map(({ id }) => id).sort(),
    budget: environment.context.budget,
  };
  const cost = costSummary(state.outcomes, environment.ports.clock.monotonicMs() - startedMs);
  const report = runReportSchema.parse({
    schemaVersion: CORE_V2_SCHEMA_VERSION,
    contractVersion: CORE_V2_CONTRACT_VERSION,
    runId: environment.context.runId,
    createdAt: environment.ports.clock.now(),
    asOfTime: environment.context.asOfTime,
    engineVersion: CORE_V2_ENGINE_VERSION,
    visibility: environment.context.visibility,
    status,
    stageOutcomes:
      state.outcomes.length > 0 ? state.outcomes : [interruptedOutcome(environment, state)],
    snapshots: state.snapshots,
    primarySnapshotId: state.primarySnapshotId,
    claims: state.claims,
    candidates: state.candidates,
    assessments: state.assessments,
    provenance: state.provenance,
    decisions: state.decisions,
    scorecard: status === "canceled" ? null : scorecard,
    inputCoverage: state.inputCoverage,
    unresolvedReasons: uniqueIssues(state.issues),
    evidenceSetHash: state.evidenceSetHash,
    replayManifest,
    cost,
  });
  return { status, report, issues: report.unresolvedReasons, replayManifest, cost };
}

function emptyState(): RunState {
  return {
    snapshots: [],
    primarySnapshotId: null,
    claims: [],
    candidates: [],
    admittedSnapshotIds: [],
    assessments: [],
    provenance: [],
    decisions: [],
    inputCoverage: [],
    outcomes: [],
    issues: [],
    evidenceSetHash: null,
    targetedRounds: 0,
  };
}

function absorbRetrieval(state: RunState, data: RetrieveEvidenceV2Data) {
  state.candidates = uniqueById([...state.candidates, ...data.candidates]);
  state.snapshots = uniqueById([...state.snapshots, ...data.snapshots]);
  state.admittedSnapshotIds = [
    ...new Set([...state.admittedSnapshotIds, ...data.admittedSnapshotIds]),
  ];
}

function setOutcome(state: RunState, stage: StageName, result: StageResult<unknown>) {
  const next = outcome(stage, result);
  const index = state.outcomes.findIndex((item) => item.stage === stage);
  if (index >= 0) state.outcomes[index] = next;
  else state.outcomes.push(next);
  state.issues.push(...result.issues);
}

function outcome(stage: StageName, result: StageResult<unknown>): StageOutcome {
  return { stage, status: result.status, issues: result.issues, metrics: result.metrics };
}

/** A follow-up round that returns no data leaves the earlier data usable but incomplete. */
function mergeResults<Value>(
  first: StageResult<Value>,
  second: StageResult<Value>,
  combine: (a: Value, b: Value) => Value,
): StageResult<Value> {
  const issues = uniqueIssues([...first.issues, ...second.issues]);
  const metrics = sumMetrics(first.metrics, second.metrics);
  if (!first.data) return { ...first, issues, metrics };
  if (!second.data) return { status: "partial", data: first.data, issues, metrics };
  return {
    status: worse(first.status, second.status),
    data: combine(first.data, second.data),
    issues,
    metrics,
  };
}

function absorbOutcome<Value>(
  result: StageResult<Value>,
  follow: StageResult<unknown>,
): StageResult<Value> {
  const issues = uniqueIssues([...result.issues, ...follow.issues]);
  const metrics = sumMetrics(result.metrics, follow.metrics);
  if (!follow.data)
    return { status: follow.status, data: null, issues, metrics } as StageResult<Value>;
  return { ...result, status: worse(result.status, follow.status), issues, metrics };
}

function combineRetrieval(a: RetrieveEvidenceV2Data, b: RetrieveEvidenceV2Data) {
  return {
    candidates: uniqueById([...a.candidates, ...b.candidates]),
    snapshots: uniqueById([...a.snapshots, ...b.snapshots]),
    admittedSnapshotIds: [...new Set([...a.admittedSnapshotIds, ...b.admittedSnapshotIds])],
    budgetUsed: {
      externalRequests: a.budgetUsed.externalRequests + b.budgetUsed.externalRequests,
      costUsd: b.budgetUsed.costUsd,
    },
    stoppingReason: b.stoppingReason,
  };
}

function combineAssessment(a: AssessEvidenceV2Data, b: AssessEvidenceV2Data) {
  return {
    assessments: uniqueById([...a.assessments, ...b.assessments]),
    sufficiency: [
      ...new Map([...a.sufficiency, ...b.sufficiency].map((item) => [item.claimId, item])).values(),
    ],
  };
}

function worse(a: StageStatus, b: StageStatus): StageStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

function sumMetrics(a: StageMetrics, b: StageMetrics): StageMetrics {
  return {
    startedAt: a.startedAt,
    completedAt: b.completedAt,
    durationMs: a.durationMs + b.durationMs,
    externalRequests: a.externalRequests + b.externalRequests,
    inputTokens: sumNullable([a.inputTokens, b.inputTokens]),
    outputTokens: sumNullable([a.outputTokens, b.outputTokens]),
    costUsd: sumNullable([a.costUsd, b.costUsd]),
  };
}

function zeroMetrics(at: string): StageMetrics {
  return {
    startedAt: at,
    completedAt: at,
    durationMs: 0,
    externalRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

function interruptedOutcome(environment: RunEnvironment, state: RunState): StageOutcome {
  const reason =
    state.issues.find(({ code }) => code === "cancellation_requested" || code === "timeout") ??
    issue("cancellation_requested", "The run was canceled before its first stage.");
  return {
    stage: "normalize_input",
    status: "failed",
    issues: [reason],
    metrics: zeroMetrics(environment.ports.clock.now()),
  };
}

function checkpointIdentity(options: RunAnalysisV2Options): Checkpointing | null {
  const attemptSet = options.attempt !== undefined;
  const tokenSet = options.fencingToken !== undefined;
  if (attemptSet !== tokenSet)
    throw new Error("Checkpointing requires both attempt and fencingToken.");
  if (!attemptSet) return null;
  if (!Number.isInteger(options.attempt) || options.attempt! < 1 || !options.fencingToken)
    throw new Error("Checkpoint identity is invalid.");
  return { attempt: options.attempt!, fencingToken: options.fencingToken! };
}

function stageRunStatus(result: StageResult<unknown>): RunStatus {
  if (result.issues.some(({ code }) => code === "cancellation_requested")) return "canceled";
  return result.status;
}

function overallStatus(outcomes: StageOutcome[]): RunStatus {
  if (outcomes.some(({ issues }) => issues.some(({ code }) => code === "cancellation_requested")))
    return "canceled";
  if (outcomes.some(({ status }) => status === "failed")) return "failed";
  if (outcomes.some(({ status }) => status === "unavailable")) return "unavailable";
  if (outcomes.some(({ status }) => status === "partial")) return "partial";
  return "complete";
}

function runIdentity(environment: RunEnvironment) {
  return {
    contract: CORE_V2_CONTRACT_VERSION,
    versions: environment.context.versions,
    budget: environment.context.budget,
    asOfTime: environment.context.asOfTime,
    inputHash: environment.context.inputHash,
  };
}

function uniqueById<Value extends { id: string }>(values: Value[]) {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function uniqueIssues(issues: CoreIssue[]) {
  return [
    ...new Map(issues.map((value) => [canonicalJson(value), issueSchema.parse(value)])).values(),
  ];
}

function issue(code: CoreIssue["code"], message: string): CoreIssue {
  return { code, severity: "warning", message, claimId: null, snapshotId: null, url: null };
}

function isStageResult(value: unknown): value is StageResult<unknown> {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<StageResult<unknown>>;
  return (
    ["complete", "partial", "unavailable", "failed"].includes(result.status ?? "") &&
    Array.isArray(result.issues) &&
    Boolean(result.metrics) &&
    result.issues.every((item) => issueSchema.safeParse(item).success)
  );
}

function canceled(environment: RunEnvironment) {
  return environment.signal.aborted || environment.context.cancellation.requested;
}

function costSummary(outcomes: StageOutcome[], latencyMs: number) {
  const metrics = outcomes.map(({ metrics }) => metrics);
  return {
    externalRequests: metrics.reduce((sum, value) => sum + value.externalRequests, 0),
    inputTokens: sumNullable(metrics.map(({ inputTokens }) => inputTokens)),
    outputTokens: sumNullable(metrics.map(({ outputTokens }) => outputTokens)),
    costUsd: sumNullable(metrics.map(({ costUsd }) => costUsd)),
    latencyMs: Math.max(0, latencyMs),
  };
}

function sumNullable(values: Array<number | null>) {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function stageStatus(report: RunReport, stage: StageName) {
  return report.stageOutcomes.find((item) => item.stage === stage)?.status ?? "failed";
}
