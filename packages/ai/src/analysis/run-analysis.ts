import { readStageCheckpoint, writeStageCheckpoint, type StageCheckpoints } from "./checkpoints";
import { isRunInterrupted, runStopReason, stopIssue } from "./interruption";
import {
  ANALYSIS_CONTRACT_VERSION,
  ANALYSIS_SCHEMA_VERSION,
  issueSchema,
  runReportSchema,
  type AnalysisIssue,
  type Decision,
  type DocumentSnapshot,
  type EvidenceAssessment,
  type EvidenceCandidate,
  type FocusedPublicationPolicy,
  type FocusedSelection,
  type InputCoverage,
  type ProvenanceGraph,
  type RunReport,
  type RunStatus,
  type StageMetrics,
  type StageName,
  type StageOutcome,
  type StageResult,
} from "@repo/contracts/analysis";
import { createAdjudicateClaims, type TargetedEvidence } from "./adjudication/index";
import { createExtractClaims } from "./claims/index";
import { accumulateEvidence, createAssessEvidence } from "./evidence/index";
import { canonicalJson, evidenceSetHash, hashValue, snapshotIdentity } from "./hashing";
import { normalizeInput } from "./ingestion/index";
import { createFocusedPublication, FOCUSED_PUBLICATION_POLICY } from "./publication/index";
import { createTraceOrigins, type ArchiveLookupPort } from "./provenance/index";
import { createRetrieveEvidence, type RetrievalOptions } from "./retrieval/index";
import { scoreReport } from "./scoring/index";
import { coverageForSelectedClaims, selectTopClaims } from "./selection/index";
import type {
  AdjudicateClaims,
  AssessEvidence,
  ExtractClaims,
  FocusedPublication,
  NormalizeInput,
  RetrieveEvidence,
  RetrieveEvidenceData,
  RunAnalysis,
  RunAnalysisInput,
  RunAnalysisResult,
  RunEnvironment,
  ScoreReport,
  TraceOrigins,
} from "./types";
import { ANALYSIS_ENGINE_VERSION } from "./types";

export { canonicalJson, hashValue } from "./hashing";

/** Shared run allowance handed to each stage so no stage can spend the whole budget again. */
export interface StageUsage {
  priorExternalRequests: number;
  priorCostUsd: number | null;
  remainingExternalRequests: number;
  deadlineMonotonicMs: number;
  priorTargetedRounds: number;
}

export interface RunAnalysisStageFactories {
  normalizeInput(usage: StageUsage): NormalizeInput;
  extractClaims(usage: StageUsage): ExtractClaims;
  retrieveEvidence(usage: StageUsage): RetrieveEvidence;
  assessEvidence(usage: StageUsage): AssessEvidence;
  traceOrigins(usage: StageUsage): TraceOrigins;
  adjudicateClaims(
    usage: StageUsage & {
      record: (evidence: TargetedEvidence, signal: AbortSignal) => Promise<void>;
    },
  ): AdjudicateClaims;
  publishFocusedDecisions(usage: StageUsage): FocusedPublication;
  scoreReport(usage: StageUsage): ScoreReport;
}

export interface RunAnalysisOptions {
  /** Elapsed wall time from earlier attempts; retries share one run deadline. */
  elapsedMs?: number;
  /** Durable, fenced round admission shared by assessment and adjudication across retries. */
  reserveTargetedRound?: () => Promise<number | null>;
  /** Lease identity. Checkpoints are read and written only when both are supplied. */
  attempt?: number;
  fencingToken?: string;
  stages?: Partial<RunAnalysisStageFactories>;
  retrieval?: Omit<RetrievalOptions, "priorExternalRequests" | "priorCostUsd">;
  archive?: ArchiveLookupPort;
}

interface RunArtifacts {
  snapshots: DocumentSnapshot[];
  primarySnapshotId: string | null;
  claims: RunReport["claims"];
  selectedClaimIds: string[];
  focusedSelection: FocusedSelection | null;
  candidates: EvidenceCandidate[];
  admittedSnapshotIds: string[];
  assessments: EvidenceAssessment[];
  provenance: ProvenanceGraph[];
  decisions:
    | { phase: "diagnostic"; values: Decision[] }
    | { phase: "evaluated"; values: Decision[]; policy: FocusedPublicationPolicy };
  inputCoverage: InputCoverage[];
  outcomes: StageOutcome[];
  issues: AnalysisIssue[];
  evidenceSetHash: string | null;
  targetedRounds: number;
  scorecard: RunReport["scorecard"];
}

interface Checkpointing {
  attempt: number;
  fencingToken: string;
}

export function createRunAnalysis(options: RunAnalysisOptions = {}): RunAnalysis {
  const checkpointing = checkpointIdentity(options);
  const factories: RunAnalysisStageFactories = {
    ...defaultStageFactories(options),
    ...options.stages,
  };

  return async (input, environment) => {
    const { clock } = environment.ports;
    const startedMs = clock.monotonicMs();
    const deadlineMonotonicMs =
      startedMs + Math.max(0, environment.context.budget.maxElapsedMs - (options.elapsedMs ?? 0));
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
    const stop = (status: RunStatus) => finishResult(status, input, environment, state, startedMs);
    const checkpointed = <Stage extends StageName>(
      stage: Stage,
      dependencyHash: string,
      execute: () => Promise<StageCheckpoints[Stage]>,
      canReuse: (checkpoint: StageCheckpoints[Stage]) => boolean = () => true,
    ) => executeStage(stage, dependencyHash, execute, environment, checkpointing, canReuse);
    const interrupted = (stage: StageName): RunAnalysisResult | null => {
      const reason = runStopReason(environment);
      if (reason) {
        state.issues.push(stopIssue(environment, `The run was canceled before ${stage}.`));
        return stop(
          reason === "cancellation_requested"
            ? "canceled"
            : state.outcomes.length === 0
              ? "failed"
              : "partial",
        );
      }
      if (clock.monotonicMs() >= deadlineMonotonicMs) {
        state.issues.push(issue("timeout", `The elapsed run cap was reached before ${stage}.`));
        return stop(state.outcomes.length === 0 ? "failed" : "partial");
      }
      return null;
    };

    const beforeNormalize = interrupted("normalize_input");
    if (beforeNormalize) return beforeNormalize;
    const normalized = transitionStage(
      "normalize_input",
      usage(),
      await checkpointed("normalize_input", hashValue({ input, identity }), async () => ({
        result: await factories.normalizeInput(usage())({ input: input.input }, environment),
        extra: null,
      })),
      environment,
    );
    retainStage(state, "normalize_input", normalized.result, (data) => {
      state.snapshots = uniqueById(data.snapshots);
      state.primarySnapshotId = data.primarySnapshotId;
    });
    if (normalized.kind === "stop") return stop(normalized.status);
    const primarySnapshotId = normalized.result.data.primarySnapshotId;

    const beforeExtract = interrupted("extract_claims");
    if (beforeExtract) return beforeExtract;
    const extracted = transitionStage(
      "extract_claims",
      usage(),
      await checkpointed(
        "extract_claims",
        hashValue({ upstream: normalized.result, identity }),
        async () => ({
          result: await factories.extractClaims(usage())(
            { snapshots: state.snapshots, primarySnapshotId },
            environment,
          ),
          extra: null,
        }),
      ),
      environment,
    );
    retainStage(state, "extract_claims", extracted.result, (data) => {
      state.claims = data.claims;
      state.inputCoverage = data.coverage;
    });
    if (extracted.kind === "stop") return stop(extracted.status);
    const focused = selectTopClaims({
      claims: state.claims,
      snapshots: state.snapshots,
      coverage: state.inputCoverage,
      inventoryStatus: extracted.result.status,
      primarySnapshotId,
    });
    state.claims = focused.claims;
    state.selectedClaimIds = focused.selection.selectedClaimIds;
    state.focusedSelection = focused.selection;
    state.issues.push(...focused.issues);
    const selectedClaims = () =>
      state.claims.filter((claim) => state.selectedClaimIds.includes(claim.id));

    const beforeRetrieve = interrupted("retrieve_evidence");
    if (beforeRetrieve) return beforeRetrieve;
    const retrieved = transitionStage(
      "retrieve_evidence",
      usage(),
      await checkpointed(
        "retrieve_evidence",
        hashValue({
          upstream: extracted.result,
          focusedSelection: state.focusedSelection,
          identity,
        }),
        async () => ({
          result: await factories.retrieveEvidence(usage())(
            { claims: selectedClaims(), snapshots: state.snapshots, round: 0, sufficiency: [] },
            environment,
          ),
          extra: null,
        }),
      ),
      environment,
    );
    retainStage(state, "retrieve_evidence", retrieved.result, (data) =>
      absorbRetrieval(state, data),
    );
    if (retrieved.kind === "stop") return stop(retrieved.status);

    const beforeAssess = interrupted("assess_evidence");
    if (beforeAssess) return beforeAssess;
    const assessPrior = usage();
    const assessedExecution = await checkpointed(
      "assess_evidence",
      hashValue({
        upstream: retrieved.result,
        snapshots: snapshotIdentity(state.snapshots),
        selectedClaimIds: state.selectedClaimIds,
        identity,
      }),
      async () => {
        let assessment = await factories.assessEvidence(usage())(
          {
            claims: selectedClaims(),
            snapshots: state.snapshots,
            admittedSnapshotIds: state.admittedSnapshotIds,
          },
          environment,
        );
        let targetedRetrieval: StageResult<RetrieveEvidenceData> | null = null;
        let snapshots = state.snapshots;
        if (assessment.data) {
          assessment = {
            ...assessment,
            data: accumulateEvidence(selectedClaims(), snapshots, assessment.data.assessments),
          };
        }
        const assessedSnapshotIds = new Set(state.admittedSnapshotIds);
        const allowedRounds = Math.max(
          0,
          environment.context.budget.maxTargetedRetrievalRounds - 1,
        );
        let rounds = 0;
        let consumedRounds = 0;
        while (assessment.data && rounds < allowedRounds && !isRunInterrupted(environment)) {
          const insufficient = assessment.data.sufficiency.filter(({ sufficient }) => !sufficient);
          if (insufficient.length === 0) break;
          const pending: StageMetrics[] = [
            assessment.metrics,
            ...(targetedRetrieval ? [targetedRetrieval.metrics] : []),
          ];
          const round = options.reserveTargetedRound
            ? await options.reserveTargetedRound()
            : rounds + 1;
          if (round === null) {
            assessment = {
              ...assessment,
              status: "partial",
              issues: [
                ...assessment.issues,
                issue(
                  "budget_exhausted",
                  "The shared targeted-round allowance was exhausted or the attempt was no longer active.",
                ),
              ],
            };
            break;
          }
          rounds += 1;
          consumedRounds = round;
          const retrieval: StageResult<RetrieveEvidenceData> = await factories.retrieveEvidence(
            usage(pending),
          )({ claims: selectedClaims(), snapshots, round, sufficiency: insufficient }, environment);
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
            { claims: selectedClaims(), snapshots, admittedSnapshotIds: fresh },
            environment,
          );
          assessment = mergeResults(assessment, reassessed, (a, b) =>
            accumulateEvidence(selectedClaims(), snapshots, a.assessments, b.assessments),
          );
        }
        return { result: assessment, extra: { targetedRetrieval, rounds: consumedRounds } };
      },
    );
    const assessMetrics = assessedExecution.extra.targetedRetrieval
      ? sumMetrics(
          assessedExecution.result.metrics,
          assessedExecution.extra.targetedRetrieval.metrics,
        )
      : assessedExecution.result.metrics;
    const assessed = transitionStage(
      "assess_evidence",
      assessPrior,
      assessedExecution,
      environment,
      assessMetrics,
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
    retainStage(state, "assess_evidence", assessed.result, (data) => {
      state.assessments = accumulateEvidence(
        selectedClaims(),
        state.snapshots,
        data.assessments,
      ).assessments;
      state.evidenceSetHash = evidenceSetHash(state.snapshots, state.assessments);
    });
    if (assessed.kind === "stop") return stop(assessed.status);

    const beforeTrace = interrupted("trace_origins");
    if (beforeTrace) return beforeTrace;
    const tracePrior = usage();
    const tracedExecution = await checkpointed(
      "trace_origins",
      hashValue({
        upstream: assessed.result,
        evidenceSetHash: state.evidenceSetHash,
        selectedClaimIds: state.selectedClaimIds,
        identity,
      }),
      async () => {
        const result = await factories.traceOrigins(usage())(
          { claims: selectedClaims(), snapshots: state.snapshots, assessments: state.assessments },
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
        const skipPairs = result.data.assessmentResults ?? [];
        const missingPairs = selectedClaims().some((claim) =>
          newSnapshotIds.some(
            (snapshotId) =>
              !skipPairs.some(
                (pair) => pair.claimId === claim.id && pair.snapshotId === snapshotId,
              ),
          ),
        );
        const failedTraversal = skipPairs.some(({ result: assessed }) => assessed.data === null);
        const reassessment =
          missingPairs && !failedTraversal
            ? await factories.assessEvidence(usage([result.metrics]))(
                {
                  claims: selectedClaims(),
                  snapshots: uniqueById([...state.snapshots, ...loaded]),
                  admittedSnapshotIds: newSnapshotIds,
                  skipPairs,
                },
                environment,
              )
            : null;
        return { result, extra: { snapshots: loaded, reassessment } };
      },
      (checkpoint) =>
        checkpoint.extra?.reassessment?.status !== "failed" &&
        !checkpoint.result.data?.assessmentResults?.some(
          ({ result }) => result.status === "failed",
        ),
    );
    const traceResult = tracedExecution.extra?.reassessment
      ? absorbOutcome(tracedExecution.result, tracedExecution.extra.reassessment)
      : tracedExecution.result;
    const traced = transitionStage(
      "trace_origins",
      tracePrior,
      { ...tracedExecution, result: traceResult },
      environment,
    );
    if (traced.extra) {
      state.snapshots = uniqueById([...state.snapshots, ...traced.extra.snapshots]);
      if (traced.extra.reassessment?.data) {
        state.assessments = accumulateEvidence(
          selectedClaims(),
          state.snapshots,
          state.assessments,
          traced.extra.reassessment.data.assessments,
        ).assessments;
      }
      state.evidenceSetHash = evidenceSetHash(state.snapshots, state.assessments);
    }
    retainStage(state, "trace_origins", traced.result, (data) => {
      state.provenance = data.graphs;
      state.assessments = accumulateEvidence(
        selectedClaims(),
        state.snapshots,
        state.assessments,
        ...(data.assessmentResults ?? []).map(({ result }) => result.data?.assessments ?? []),
      ).assessments;
      state.evidenceSetHash = evidenceSetHash(state.snapshots, state.assessments);
    });
    if (traced.kind === "stop" && traced.status === "canceled") return stop(traced.status);
    const failedTraversal = traced.result.data?.assessmentResults?.find(
      ({ result }) => !result.data,
    );
    if (failedTraversal) return stop(stageRunStatus(failedTraversal.result));
    if (traced.extra?.reassessment && !traced.extra.reassessment.data)
      return stop(stageRunStatus(traced.extra.reassessment));
    if (traced.kind === "stop") return stop(traced.status);

    const beforeAdjudicate = interrupted("adjudicate_claims");
    if (beforeAdjudicate) return beforeAdjudicate;
    const adjudicated = transitionStage(
      "adjudicate_claims",
      usage(),
      await checkpointed(
        "adjudicate_claims",
        hashValue({
          upstream: traced.result,
          reassessment: traced.extra?.reassessment ?? null,
          evidenceSetHash: state.evidenceSetHash,
          targetedRounds: state.targetedRounds,
          selectedClaimIds: state.selectedClaimIds,
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
            {
              claims: selectedClaims(),
              assessments: state.assessments,
              graphs: state.provenance,
            },
            environment,
          );
          return { result, extra: targeted };
        },
      ),
      environment,
    );
    for (const evidence of adjudicated.extra) {
      state.targetedRounds = Math.max(state.targetedRounds, evidence.round);
      state.candidates = uniqueById([...state.candidates, ...evidence.candidates]);
      state.snapshots = uniqueById([...state.snapshots, ...evidence.snapshots]);
      state.assessments = accumulateEvidence(
        selectedClaims(),
        state.snapshots,
        state.assessments,
        evidence.assessments,
      ).assessments;
      state.admittedSnapshotIds = [
        ...new Set([...state.admittedSnapshotIds, ...evidence.admittedSnapshotIds]),
      ];
    }
    if (adjudicated.extra.length > 0)
      state.evidenceSetHash = evidenceSetHash(state.snapshots, state.assessments);
    retainStage(state, "adjudicate_claims", adjudicated.result, (data) => {
      state.decisions = { phase: "diagnostic", values: data.decisions };
    });
    if (adjudicated.kind === "stop") return stop(adjudicated.status);

    const beforePublication = interrupted("calibrate_decisions");
    if (beforePublication) return beforePublication;
    const decisionStage = transitionStage(
      "calibrate_decisions",
      usage(),
      await checkpointed(
        "calibrate_decisions",
        hashValue({
          upstream: adjudicated.result,
          evidenceSetHash: state.evidenceSetHash,
          selectedClaimIds: state.selectedClaimIds,
          identity,
        }),
        async () => {
          const result = await factories.publishFocusedDecisions(usage())(
            {
              claims: selectedClaims(),
              snapshots: state.snapshots,
              decisions: state.decisions.values,
              assessments: state.assessments,
            },
            environment,
          );
          return {
            result,
            extra: null,
          };
        },
      ),
      environment,
    );
    retainStage(state, "calibrate_decisions", decisionStage.result, (data) => {
      state.decisions = { phase: "evaluated", values: data.decisions, policy: data.policy };
    });
    if (decisionStage.kind === "stop") return stop(decisionStage.status);

    const beforeScore = interrupted("score_report");
    if (beforeScore) return beforeScore;
    const scored = transitionStage(
      "score_report",
      usage(),
      await checkpointed(
        "score_report",
        hashValue({
          upstream: decisionStage.result,
          evidenceSetHash: state.evidenceSetHash,
          selectedClaimIds: state.selectedClaimIds,
          identity,
        }),
        async () => ({
          result: factories.scoreReport(usage())({
            claims: selectedClaims(),
            decisions: state.decisions.values,
            assessments: state.assessments,
            graphs: state.provenance,
            snapshots: state.snapshots,
            focusedSelection: focused.selection,
            coverage: coverageForSelectedClaims(
              state.inputCoverage,
              new Set(state.selectedClaimIds),
            ),
            inputStatus: normalized.result.status,
            extractionStatus: extracted.result.status,
            at: clock.now(),
          }),
          extra: null,
        }),
      ),
      environment,
    );
    retainStage(state, "score_report", scored.result, (data) => {
      state.scorecard = data.scorecard;
    });
    if (scored.kind === "stop") return stop(scored.status);
    const afterScore = interrupted("score_report");
    if (afterScore) return afterScore;
    return finishResult(overallStatus(state.outcomes), input, environment, state, startedMs);
  };
}

export const runAnalysis: RunAnalysis = createRunAnalysis();

function defaultStageFactories(options: RunAnalysisOptions): RunAnalysisStageFactories {
  return {
    normalizeInput: () => normalizeInput,
    extractClaims: (usage) =>
      createExtractClaims({
        // Focused selection happens only after the complete inventory exists.
        maxAnalyzedClaims: null,
        maxGenerationRequests: usage.remainingExternalRequests,
        deadlineMonotonicMs: usage.deadlineMonotonicMs,
      }),
    retrieveEvidence: (usage) =>
      createRetrieveEvidence({
        ...options.retrieval,
        priorExternalRequests: usage.priorExternalRequests,
        priorCostUsd: usage.priorCostUsd,
      }),
    assessEvidence: (usage) =>
      createAssessEvidence({
        maxGenerationRequests: usage.remainingExternalRequests,
        deadlineMonotonicMs: usage.deadlineMonotonicMs,
      }),
    traceOrigins: (usage) =>
      createTraceOrigins({
        ...(options.retrieval ? { retrievalOptions: options.retrieval } : {}),
        ...(options.archive ? { archive: options.archive } : {}),
        priorExternalRequests: usage.priorExternalRequests,
        priorCostUsd: usage.priorCostUsd,
      }),
    adjudicateClaims: (usage) =>
      createAdjudicateClaims({
        priorExternalRequests: usage.priorExternalRequests,
        priorCostUsd: usage.priorCostUsd,
        priorTargetedRounds: usage.priorTargetedRounds,
        reserveTargetedRound: options.reserveTargetedRound,
        targetedReassessment: {
          ...(options.retrieval ? { retrievalOptions: options.retrieval } : {}),
          record: usage.record,
        },
      }),
    publishFocusedDecisions: () => createFocusedPublication(),
    scoreReport: () => scoreReport,
  };
}

async function executeStage<Stage extends StageName>(
  stage: Stage,
  dependencyHash: string,
  execute: () => Promise<StageCheckpoints[Stage]>,
  environment: RunEnvironment,
  checkpointing: Checkpointing | null,
  canReuse: (checkpoint: StageCheckpoints[Stage]) => boolean,
): Promise<StageCheckpoints[Stage]> {
  environment.signal.throwIfAborted();
  if (checkpointing) {
    const saved = await environment.ports.runs.readCheckpoint({
      runId: environment.context.runId,
      stage,
      signal: environment.signal,
    });
    if (saved?.checkpointHash === dependencyHash) {
      const checkpoint = readStageCheckpoint(stage, saved.payloadJson);
      if (checkpoint && canReuse(checkpoint)) return checkpoint;
    }
  }
  const executed = await execute();
  if (
    checkpointing &&
    executed.result.status !== "failed" &&
    canReuse(executed) &&
    !isRunInterrupted(environment)
  ) {
    await environment.ports.runs.checkpoint({
      runId: environment.context.runId,
      stage,
      attempt: checkpointing.attempt,
      fencingToken: checkpointing.fencingToken,
      checkpointHash: dependencyHash,
      payloadJson: writeStageCheckpoint(stage, executed),
      signal: environment.signal,
    });
  }
  return executed;
}

function finishResult(
  status: RunStatus,
  input: RunAnalysisInput,
  environment: RunEnvironment,
  state: RunArtifacts,
  startedMs: number,
): RunAnalysisResult {
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
  const publicationPolicy =
    state.focusedSelection === null
      ? null
      : state.decisions.phase === "evaluated"
        ? state.decisions.policy
        : FOCUSED_PUBLICATION_POLICY;
  const decisions =
    state.decisions.phase === "evaluated"
      ? state.decisions.values
      : state.decisions.values.map((decision) => ({
          ...decision,
          publishedLabel: "unverified" as const,
          calibration: {
            applicability: "unavailable" as const,
            calibratedCorrectness: null,
            calibratorVersion: null,
            reason:
              "The run stopped before focused publication evaluated this diagnostic decision.",
          },
          focusedPublication: {
            policyVersion: FOCUSED_PUBLICATION_POLICY.policyVersion,
            decisionVersion: FOCUSED_PUBLICATION_POLICY.decisionVersion,
            status: "not_evaluated" as const,
            gate: "not_evaluated" as const,
            calibration: FOCUSED_PUBLICATION_POLICY.calibration,
          },
        }));
  const report = runReportSchema.parse({
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    contractVersion: ANALYSIS_CONTRACT_VERSION,
    runId: environment.context.runId,
    createdAt: environment.ports.clock.now(),
    asOfTime: environment.context.asOfTime,
    engineVersion: ANALYSIS_ENGINE_VERSION,
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
    decisions,
    scorecard: status === "canceled" ? null : state.scorecard,
    inputCoverage: state.inputCoverage,
    unresolvedReasons: uniqueIssues(state.issues),
    evidenceSetHash: state.evidenceSetHash,
    replayManifest,
    cost,
    ...(state.focusedSelection === null ? {} : { focusedSelection: state.focusedSelection }),
    ...(publicationPolicy === null ? {} : { focusedPublicationPolicy: publicationPolicy }),
  });
  return { status, report, issues: report.unresolvedReasons, replayManifest, cost };
}

function emptyState(): RunArtifacts {
  return {
    snapshots: [],
    primarySnapshotId: null,
    claims: [],
    selectedClaimIds: [],
    focusedSelection: null,
    candidates: [],
    admittedSnapshotIds: [],
    assessments: [],
    provenance: [],
    decisions: { phase: "diagnostic", values: [] },
    inputCoverage: [],
    outcomes: [],
    issues: [],
    evidenceSetHash: null,
    targetedRounds: 0,
    scorecard: null,
  };
}

function absorbRetrieval(state: RunArtifacts, data: RetrieveEvidenceData) {
  state.candidates = uniqueById([...state.candidates, ...data.candidates]);
  state.snapshots = uniqueById([...state.snapshots, ...data.snapshots]);
  state.admittedSnapshotIds = [
    ...new Set([...state.admittedSnapshotIds, ...data.admittedSnapshotIds]),
  ];
}

function retainStage<Data>(
  state: RunArtifacts,
  stage: StageName,
  result: StageResult<Data>,
  retain: (data: Data) => void,
) {
  if (result.data !== null) retain(result.data);
  setOutcome(state, stage, result);
}

function setOutcome(state: RunArtifacts, stage: StageName, result: StageResult<unknown>) {
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
  if (first.status === "failed" || first.status === "unavailable")
    return { ...first, issues, metrics };
  if (second.status === "failed" || second.status === "unavailable")
    return { status: "partial", data: first.data, issues, metrics };
  return {
    status: first.status === "partial" || second.status === "partial" ? "partial" : "complete",
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
  if (result.status === "failed" || result.status === "unavailable")
    return { ...result, issues, metrics };
  return {
    status: follow.status === "complete" && result.status === "complete" ? "complete" : "partial",
    data: result.data,
    issues,
    metrics,
  };
}

function combineRetrieval(a: RetrieveEvidenceData, b: RetrieveEvidenceData) {
  return {
    candidates: uniqueById([...a.candidates, ...b.candidates]),
    snapshots: uniqueById([...a.snapshots, ...b.snapshots]),
    admittedSnapshotIds: [...new Set([...a.admittedSnapshotIds, ...b.admittedSnapshotIds])],
    budgetUsed: {
      externalRequests: a.budgetUsed.externalRequests + b.budgetUsed.externalRequests,
      costUsd: sumNullable([a.budgetUsed.costUsd, b.budgetUsed.costUsd]),
    },
    stoppingReason: b.stoppingReason,
  };
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

function interruptedOutcome(environment: RunEnvironment, state: RunArtifacts): StageOutcome {
  const reason =
    state.issues.find(
      ({ code }) =>
        code === "cancellation_requested" || code === "timeout" || code === "budget_exhausted",
    ) ?? issue("cancellation_requested", "The run was canceled before its first stage.");
  return {
    stage: "normalize_input",
    status: "failed",
    issues: [reason],
    metrics: zeroMetrics(environment.ports.clock.now()),
  };
}

function checkpointIdentity(options: RunAnalysisOptions): Checkpointing | null {
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

type StageTransition<Data, Extra> =
  | {
      kind: "continue";
      result: Extract<StageResult<Data>, { status: "complete" | "partial" }>;
      extra: Extra;
    }
  | { kind: "stop"; status: RunStatus; result: StageResult<Data>; extra: Extra };

function transitionStage<Data, Extra>(
  stage: StageName,
  prior: StageUsage,
  execution: { result: StageResult<Data>; extra: Extra },
  environment: RunEnvironment,
  metrics = execution.result.metrics,
): StageTransition<Data, Extra> {
  const violations: AnalysisIssue[] = [];
  const externalRequests = prior.priorExternalRequests + metrics.externalRequests;
  if (externalRequests > environment.context.budget.maxExternalRequests) {
    violations.push(
      issue(
        "budget_exhausted",
        `The shared request cap was exceeded after ${stage}; the run stopped before further work.`,
      ),
    );
  }
  const totalCost = sumNullable([prior.priorCostUsd, metrics.costUsd]);
  if (
    environment.context.budget.maxCostUsd !== null &&
    (totalCost === null || totalCost > environment.context.budget.maxCostUsd)
  ) {
    violations.push(
      issue(
        "budget_exhausted",
        `The shared cost cap was exceeded or became unknown after ${stage}; the run stopped before further work.`,
      ),
    );
  }
  if (environment.ports.clock.monotonicMs() >= prior.deadlineMonotonicMs) {
    violations.push(issue("timeout", `The elapsed run cap was reached after ${stage}.`));
  }
  if (runStopReason(environment))
    violations.push(stopIssue(environment, `The run was canceled after ${stage}.`));
  const original = execution.result;
  let result: StageResult<Data> =
    violations.length === 0
      ? original
      : {
          ...original,
          issues: uniqueIssues([...original.issues, ...violations]),
        };
  if (violations.length > 0 && result.status === "complete")
    result = { ...result, status: "partial" };
  const status = stageRunStatus(result);
  if (
    status === "canceled" ||
    violations.length > 0 ||
    result.status === "failed" ||
    result.status === "unavailable"
  ) {
    return {
      kind: "stop",
      status:
        status === "canceled"
          ? status
          : result.status === "failed" || result.status === "unavailable"
            ? status
            : "partial",
      result,
      extra: execution.extra,
    };
  }
  return { kind: "continue", result, extra: execution.extra };
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
    contract: ANALYSIS_CONTRACT_VERSION,
    focusedMode: true,
    focusedPublicationPolicyVersion: FOCUSED_PUBLICATION_POLICY.policyVersion,
    focusedPublicationDecisionVersion: FOCUSED_PUBLICATION_POLICY.decisionVersion,
    versions: environment.context.versions,
    budget: environment.context.budget,
    asOfTime: environment.context.asOfTime,
    inputHash: environment.context.inputHash,
  };
}

function uniqueById<Value extends { id: string }>(values: Value[]) {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function uniqueIssues(issues: AnalysisIssue[]) {
  return [
    ...new Map(issues.map((value) => [canonicalJson(value), issueSchema.parse(value)])).values(),
  ];
}

function issue(code: AnalysisIssue["code"], message: string): AnalysisIssue {
  return { code, severity: "warning", message, claimId: null, snapshotId: null, url: null };
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
