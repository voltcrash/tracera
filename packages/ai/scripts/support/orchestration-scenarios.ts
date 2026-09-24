/*
 * Durable Core v2 orchestration fixtures. The in-memory repository mirrors the PostgreSQL
 * repository's scope, lease, fencing, cancellation and snapshot-immutability rules so the
 * real worker and engine can be driven through submit, disconnect, crash, cancel and reuse
 * without a database. Stage outputs are synthetic; they demonstrate invariants, not accuracy.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  coreV2Examples,
  documentSnapshotSchema,
  runContextExample,
  runReportSchema,
  type CoreIssue,
  type DocumentSnapshot,
  type RunContext,
  type RunReport,
  type StageMetrics,
  type StageName,
  type StageResult,
} from "@repo/contracts/core-v2";
import type {
  CoreAccessScope,
  CoreRunProgress,
  CoreScopedLease,
  CoreStorageRepository,
} from "@repo/db/core";
import { createCalibrateDecisionsV2 } from "../../src/core/calibration/index.js";
import {
  createCoreJobPayload,
  createReservedExternalCall,
  createRunAnalysisV2,
  evidenceSetHash,
  hashValue,
  projectReport,
  replayAnalysisV2,
  runCoreWorker,
  type CoreInput,
  type CorePorts,
  type CoreWorkerRepository,
  type RunAnalysisV2StageFactories,
  type RunEnvironment,
  type StageUsage,
} from "../../src/core/index.js";
import {
  FIXTURE_CALIBRATOR_VERSION,
  syntheticCalibratorArtifact,
} from "./scripted-adjudication.js";

export const ORCHESTRATION_SCENARIOS = [
  "submit_disconnect_resume",
  "crash_retry_same_reservation",
  "explicit_cancel",
  "cached_exact_repeat",
  "url_content_change",
  "report_rendering",
  "owner_isolation",
  "checkpoint_invalidation",
  "shared_run_budget",
  "deterministic_replay",
  "targeted_sufficiency_round",
  "provenance_reassessment",
] as const;
export type OrchestrationScenario = (typeof ORCHESTRATION_SCENARIOS)[number];

const EXAMPLE = coreV2Examples.complete;
const EXAMPLE_INPUT = EXAMPLE.snapshots[0]!;
const EXAMPLE_EVIDENCE = EXAMPLE.snapshots[1]!;
const EXAMPLE_CLAIM_ID = EXAMPLE.claims[0]!.id;
export const FIXTURE_URL = "https://news.example.org/aurora-turin";
export const ORIGINAL_ARTICLE = EXAMPLE_INPUT.normalizedText;
export const CHANGED_ARTICLE = "Aurora Labs closed a plant in Turin in 2024.";
const SCOPE_A: CoreAccessScope = {
  tenantId: runContextExample.tenantId,
  ownerUserId: runContextExample.ownerUserId,
  visibility: runContextExample.visibility,
};
const SCOPE_B: CoreAccessScope = {
  tenantId: "tenant_other",
  ownerUserId: "user_other",
  visibility: "private",
};

class StaleLease extends Error {}
class ScopeViolation extends Error {}

interface MemoryJob {
  runId: string;
  scopeKey: string;
  scope: CoreAccessScope;
  context: RunContext;
  stage: StageName;
  payload: unknown;
  status: CoreRunProgress["status"];
  attempt: number;
  maxAttempts: number;
  fencingToken: string | null;
  leaseExpiresAt: number | null;
  availableAt: number;
  cancellationRequested: boolean;
  updatedAt: number;
  lastError: string | null;
}

/** Mirrors the PostgreSQL CoreStorageRepository semantics used by the durable worker. */
export class MemoryCoreRepository implements CoreWorkerRepository {
  readonly jobs = new Map<string, MemoryJob>();
  readonly checkpoints = new Map<
    string,
    { checkpointHash: string; payloadJson: string; order: number }
  >();
  readonly snapshots = new Map<string, DocumentSnapshot>();
  readonly reports = new Map<string, { scopeKey: string; report: RunReport; order: number }>();
  readonly runStatus = new Map<string, string>();
  private order = 0;
  clockOffsetMs = 0;

  now() {
    return Date.now() + this.clockOffsetMs;
  }

  async enqueue(input: {
    context: RunContext;
    stage: StageName;
    payload: unknown;
    maxAttempts: number;
  }) {
    const scope = scopeOf(input.context);
    const existing = this.jobs.get(input.context.runId);
    if (existing) {
      if (existing.scopeKey !== key(scope))
        throw new ScopeViolation("Run is outside the caller scope.");
      if (hashValue(existing.payload) !== hashValue(input.payload))
        throw new Error("Duplicate enqueue key was reused with a different payload.");
      return { jobId: `${input.context.runId}:${input.stage}`, created: false };
    }
    this.jobs.set(input.context.runId, {
      runId: input.context.runId,
      scopeKey: key(scope),
      scope,
      context: input.context,
      stage: input.stage,
      payload: structuredClone(input.payload),
      status: "queued",
      attempt: 0,
      maxAttempts: input.maxAttempts,
      fencingToken: null,
      leaseExpiresAt: null,
      availableAt: this.now(),
      cancellationRequested: false,
      updatedAt: this.now(),
      lastError: null,
    });
    return { jobId: `${input.context.runId}:${input.stage}`, created: true };
  }

  async acquireNextLease(input: {
    workerId: string;
    leaseSeconds: number;
  }): Promise<CoreScopedLease | null> {
    const now = this.now();
    for (const job of this.jobs.values()) {
      if (job.status !== "leased" || (job.leaseExpiresAt ?? 0) > now) continue;
      if (job.cancellationRequested) this.terminal(job, "canceled");
      else if (job.attempt >= job.maxAttempts) this.terminal(job, "failed");
    }
    const job = [...this.jobs.values()].find(
      (item) =>
        !item.cancellationRequested &&
        item.attempt < item.maxAttempts &&
        item.availableAt <= now &&
        (item.status === "queued" ||
          item.status === "retry" ||
          (item.status === "leased" && (item.leaseExpiresAt ?? 0) <= now)),
    );
    if (!job) return null;
    job.status = "leased";
    job.attempt += 1;
    job.fencingToken = `${input.workerId}:${randomUUID()}`;
    job.leaseExpiresAt = now + input.leaseSeconds * 1_000;
    job.updatedAt = now;
    return structuredClone({
      scope: job.scope,
      context: job.context,
      jobId: `${job.runId}:${job.stage}`,
      runId: job.runId,
      stage: job.stage,
      payload: job.payload,
      attempt: job.attempt,
      fencingToken: job.fencingToken,
      leaseExpiresAt: new Date(job.leaseExpiresAt).toISOString(),
      cancellationRequested: job.cancellationRequested,
    });
  }

  async renewLease(input: Fenced & { leaseSeconds: number }) {
    const job = this.fenced(input);
    if (job.cancellationRequested) throw new StaleLease("Lease is canceled.");
    job.leaseExpiresAt = this.now() + input.leaseSeconds * 1_000;
    return new Date(job.leaseExpiresAt).toISOString();
  }

  async retry(input: Fenced & { error: string; backoffMs: number }) {
    const job = this.fenced(input);
    const terminal = job.attempt >= job.maxAttempts;
    job.status = terminal ? "failed" : "retry";
    job.lastError = input.error;
    job.availableAt = this.now() + input.backoffMs;
    job.fencingToken = null;
    job.leaseExpiresAt = null;
    job.updatedAt = this.now();
    if (terminal) this.runStatus.set(job.runId, "failed");
    return { terminal };
  }

  async requestCancellation(input: {
    scope: CoreAccessScope;
    runId: string;
    reason: "user_request";
  }) {
    const job = this.jobs.get(input.runId);
    if (!job || job.scopeKey !== key(input.scope) || this.runStatus.has(job.runId)) return false;
    job.cancellationRequested = true;
    job.updatedAt = this.now();
    if (job.status === "queued" || job.status === "retry") this.terminal(job, "canceled");
    return true;
  }

  async acknowledgeCancellation(input: Fenced) {
    const job = this.jobs.get(input.runId);
    if (
      !job ||
      job.scopeKey !== key(input.scope) ||
      job.status !== "leased" ||
      job.fencingToken !== input.fencingToken ||
      job.attempt !== input.attempt ||
      !job.cancellationRequested
    )
      throw new StaleLease("Cancellation acknowledgement rejected for stale worker.");
    this.terminal(job, "canceled");
  }

  async getRunProgress(input: {
    scope: CoreAccessScope;
    runId: string;
  }): Promise<CoreRunProgress | null> {
    const job = this.jobs.get(input.runId);
    if (!job || job.scopeKey !== key(input.scope)) return null;
    const completedStages = [...this.checkpoints.entries()]
      .filter(([id]) => id.startsWith(`${job.scopeKey}|${job.runId}|`))
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([id]) => id.split("|").at(-1) as StageName);
    return {
      runId: job.runId,
      status:
        job.status === "complete"
          ? ((this.runStatus.get(job.runId) as CoreRunProgress["status"] | undefined) ?? job.status)
          : job.status,
      stage: job.stage,
      attempt: job.attempt,
      cancellationRequested: job.cancellationRequested,
      leaseExpiresAt:
        job.leaseExpiresAt === null ? null : new Date(job.leaseExpiresAt).toISOString(),
      completedStages,
      updatedAt: new Date(job.updatedAt).toISOString(),
    };
  }

  async findLatestCompletedReport(input: { scope: CoreAccessScope; inputHash: string }) {
    const matches = [...this.reports.values()]
      .filter(
        ({ scopeKey, report }) =>
          scopeKey === key(input.scope) &&
          report.replayManifest.inputHash === input.inputHash &&
          this.runStatus.get(report.runId) === "complete",
      )
      .sort((a, b) => b.order - a.order);
    return matches[0]?.report ?? null;
  }

  async getLatestReport(input: { scope: CoreAccessScope; runId: string }) {
    const stored = this.reports.get(input.runId);
    return stored && stored.scopeKey === key(input.scope) ? stored.report : null;
  }

  async checkpoint(input: Fenced & { checkpointHash: string; payloadJson: string }) {
    this.fenced(input);
    this.checkpoints.set(`${key(input.scope)}|${input.runId}|${input.stage}`, {
      checkpointHash: input.checkpointHash,
      payloadJson: input.payloadJson,
      order: this.order++,
    });
  }

  async readCheckpoint(input: { scope: CoreAccessScope; runId: string; stage: StageName }) {
    const saved = this.checkpoints.get(`${key(input.scope)}|${input.runId}|${input.stage}`);
    return saved ? { checkpointHash: saved.checkpointHash, payloadJson: saved.payloadJson } : null;
  }

  async finalize(input: {
    scope: CoreAccessScope;
    runId: string;
    fencingToken: string;
    reportHash: string;
    report: RunReport;
  }) {
    const job = this.jobs.get(input.runId);
    if (
      !job ||
      job.scopeKey !== key(input.scope) ||
      job.status !== "leased" ||
      job.fencingToken !== input.fencingToken ||
      (job.leaseExpiresAt ?? 0) <= this.now() ||
      job.cancellationRequested
    )
      throw new StaleLease("Finalization rejected for stale worker.");
    const report = runReportSchema.parse(input.report);
    for (const snapshot of report.snapshots) {
      const stored = this.snapshots.get(`${key(input.scope)}|${snapshot.id}`);
      if (!stored || stored.contentHash !== snapshot.contentHash)
        throw new Error(`Report references snapshot ${snapshot.id} that is not stored in scope.`);
    }
    this.reports.set(input.runId, { scopeKey: job.scopeKey, report, order: this.order++ });
    this.terminal(job, "complete");
    this.runStatus.set(job.runId, report.status);
  }

  async putSnapshot(input: { scope: CoreAccessScope; snapshot: DocumentSnapshot }) {
    const snapshot = documentSnapshotSchema.parse(input.snapshot);
    const id = `${key(input.scope)}|${snapshot.id}`;
    const existing = this.snapshots.get(id);
    if (!existing) {
      this.snapshots.set(id, structuredClone(snapshot));
      return;
    }
    if (hashValue(existing) !== hashValue(snapshot))
      throw new Error("Snapshot IDs are immutable and cannot be overwritten.");
  }

  async getSnapshot(input: { scope: CoreAccessScope; snapshotId: string }) {
    return structuredClone(this.snapshots.get(`${key(input.scope)}|${input.snapshotId}`) ?? null);
  }

  async getSnapshots(input: { scope: CoreAccessScope; snapshotIds: string[] }) {
    return input.snapshotIds.flatMap((id) => {
      const snapshot = this.snapshots.get(`${key(input.scope)}|${id}`);
      return snapshot ? [structuredClone(snapshot)] : [];
    });
  }

  private fenced(input: Fenced) {
    const job = this.jobs.get(input.runId);
    if (
      !job ||
      job.scopeKey !== key(input.scope) ||
      job.status !== "leased" ||
      job.fencingToken !== input.fencingToken ||
      job.attempt !== input.attempt ||
      (job.leaseExpiresAt ?? 0) <= this.now()
    )
      throw new StaleLease("Lease is expired, canceled, or superseded.");
    return job;
  }

  private terminal(job: MemoryJob, status: "complete" | "failed" | "canceled") {
    job.status = status;
    job.fencingToken = null;
    job.leaseExpiresAt = null;
    job.updatedAt = this.now();
    if (status !== "complete") this.runStatus.set(job.runId, status);
  }
}

interface Fenced {
  scope: CoreAccessScope;
  runId: string;
  stage: StageName;
  attempt: number;
  fencingToken: string;
}

type Hook = (environment: RunEnvironment, invocation: number) => Promise<void>;

export class OrchestrationWorld {
  readonly repository = new MemoryCoreRepository();
  readonly remote = new Map<string, string>([[FIXTURE_URL, ORIGINAL_ARTICLE]]);
  readonly calls = new Map<string, number>();
  readonly usage = new Map<string, StageUsage[]>();
  readonly reservations = new Map<string, { runId: string; settled: boolean }>();
  readonly terminals: Array<{ runId: string; outcome: string }> = [];
  readonly errors: string[] = [];
  readonly hooks = new Map<string, Hook>();
  providerCalls = 0;
  versions: RunContext["versions"] = {
    ...runContextExample.versions,
    calibration: FIXTURE_CALIBRATOR_VERSION,
  };
  retrievalRequests = 2;
  evidenceSuffix = "";
  requireTargetedRound = false;
  provenanceSuffix: string | null = null;
  calibratorArtifact: unknown = syntheticCalibratorArtifact();
  private workerController: AbortController | null = null;

  async submit(
    input: CoreInput,
    options: { scope?: CoreAccessScope; allowReuse?: boolean; asOfTime?: string } = {},
  ) {
    const scope = options.scope ?? SCOPE_A;
    const context: RunContext = {
      ...runContextExample,
      ...scope,
      runId: `run_${randomUUID()}`,
      inputHash: hashValue(input),
      asOfTime: options.asOfTime ?? new Date(this.repository.now()).toISOString(),
      versions: this.versions,
      executionMode: "fixture",
      auditSinkId: "fixture-audit",
    };
    await this.repository.enqueue({
      context,
      stage: "normalize_input",
      payload: createCoreJobPayload(input, { allowReuse: options.allowReuse ?? true }),
      maxAttempts: 3,
    });
    return { runId: context.runId, scope };
  }

  /** Runs one worker until every listed run reaches a terminal state or the worker is stopped. */
  async drain(runIds: string[], options: { timeoutMs?: number } = {}) {
    const controller = new AbortController();
    this.workerController = controller;
    const worker = runCoreWorker({
      repository: this.repository,
      workerId: `fixture-worker-${randomUUID()}`,
      leaseSeconds: 30,
      idleMs: 1,
      retryBackoffMs: 0,
      cancellationPollMs: 2,
      reuseMaxAgeMs: 60 * 60 * 1_000,
      signal: controller.signal,
      engineOptions: {
        stages: this.stageFactories(),
      },
      createPorts: ({ lease }) => this.ports(lease.runId),
      onError: (error) => this.errors.push(error instanceof Error ? error.message : String(error)),
      onTerminal: async (lease, outcome) => {
        this.terminals.push({ runId: lease.runId, outcome });
        for (const reservation of this.reservations.values())
          if (reservation.runId === lease.runId) reservation.settled = true;
      },
    });
    const deadline = Date.now() + (options.timeoutMs ?? 5_000);
    while (!controller.signal.aborted) {
      const statuses = runIds.map((runId) => this.repository.jobs.get(runId)?.status);
      if (
        statuses.every(
          (status) => status === "complete" || status === "failed" || status === "canceled",
        )
      )
        break;
      if (Date.now() > deadline) {
        controller.abort();
        await worker;
        throw new Error(
          `Runs did not settle: ${statuses.join(", ")}; errors: ${this.errors.join(" | ")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    controller.abort();
    await worker;
  }

  stopWorker() {
    this.workerController?.abort();
  }

  count(name: string) {
    return this.calls.get(name) ?? 0;
  }

  report(runId: string, scope: CoreAccessScope = SCOPE_A) {
    return this.repository.getLatestReport({ scope, runId });
  }

  ports(runId: string): Omit<CorePorts, "snapshots" | "runs"> {
    const withExternalCall = createReservedExternalCall({
      runId,
      estimatedUsd: 0.02,
      reserve: async ({ reservationId }) => {
        if (!this.reservations.has(reservationId))
          this.reservations.set(reservationId, { runId, settled: false });
        return { allowed: true };
      },
      onReserved: () => undefined,
    });
    return {
      generation: {
        modelId: this.versions.model,
        promptVersion: this.versions.prompt,
        generate: async (request) =>
          withExternalCall(`${request.schemaName}:${request.prompt}`, async () => {
            this.providerCalls += 1;
            return {
              value: undefined as never,
              usage: { inputTokens: null, outputTokens: null, costUsd: null },
              attempts: 1,
            };
          }),
      },
      embeddings: {
        modelId: this.versions.embedding.model,
        dimensions: this.versions.embedding.dimensions,
        preprocessing: this.versions.embedding.preprocessing,
        embed: async () => {
          throw new Error("Orchestration fixtures make no embedding calls.");
        },
      },
      search: [],
      documents: {
        acquire: async () => {
          throw new Error("Orchestration fixtures acquire documents through the scripted web.");
        },
        acquireFromText: async () => {
          throw new Error("Orchestration fixtures normalize text through the scripted stage.");
        },
      },
      clock: {
        now: () => new Date(this.repository.now()).toISOString(),
        monotonicMs: () => performance.now(),
      },
      audit: { sinkId: "fixture-audit", record: async () => undefined },
    };
  }

  stageFactories(): Partial<RunAnalysisV2StageFactories> {
    const enter = async (name: string, environment: RunEnvironment, usage: StageUsage) => {
      const invocation = this.count(name) + 1;
      this.calls.set(name, invocation);
      this.usage.set(name, [...(this.usage.get(name) ?? []), usage]);
      await this.hooks.get(name)?.(environment, invocation);
      environment.signal.throwIfAborted();
    };
    return {
      normalizeInput:
        (usage) =>
        async ({ input }, environment) => {
          await enter("normalize_input", environment, usage);
          const url = input.kind === "link" ? input.url : null;
          const text = input.kind === "text" ? input.text : url ? this.remote.get(url) : undefined;
          if (text === undefined)
            return unavailable("content_unavailable", "The scripted page is absent.");
          const snapshot = submittedSnapshot(text, url, environment.ports.clock.now());
          await environment.ports.snapshots.put(snapshot, environment.signal);
          return complete({ snapshots: [snapshot], primarySnapshotId: snapshot.id }, url ? 1 : 0);
        },
      extractClaims:
        (usage) =>
        async ({ snapshots, primarySnapshotId }, environment) => {
          await enter("extract_claims", environment, usage);
          const primary = snapshots.find(({ id }) => id === primarySnapshotId)!;
          const ids = fixtureIds(primary);
          return complete(
            { claims: remap(EXAMPLE.claims, ids), coverage: remap(EXAMPLE.inputCoverage, ids) },
            1,
          );
        },
      retrieveEvidence:
        (usage) =>
        async ({ claims, round }, environment) => {
          await enter(`retrieve_evidence:${round}`, environment, usage);
          const evidence = evidenceSnapshot(
            round === 0 ? this.evidenceSuffix : ` Targeted round ${round}.`,
          );
          const ids = idsForClaim(claims[0]!.id, claims[0]!.documentId, evidence.id);
          await environment.ports.snapshots.put(evidence, environment.signal);
          return complete(
            {
              candidates: remap(EXAMPLE.candidates, ids),
              snapshots: [evidence],
              admittedSnapshotIds: [evidence.id],
              budgetUsed: { externalRequests: this.retrievalRequests, costUsd: 0 },
              stoppingReason: "plan_complete" as const,
            },
            this.retrievalRequests,
          );
        },
      assessEvidence:
        (usage) =>
        async ({ claims, admittedSnapshotIds }, environment) => {
          await enter("assess_evidence", environment, usage);
          const claim = claims[0]!;
          await environment.ports.generation.generate({
            schemaName: "fixture-assessment",
            schema: undefined as never,
            system: "fixture",
            prompt: claim.id,
            untrustedContent: [],
            images: [],
            maxOutputTokens: null,
            signal: environment.signal,
          });
          await this.hooks.get("assess_evidence:after_provider")?.(
            environment,
            this.count("assess_evidence"),
          );
          const invocation = this.count("assess_evidence");
          return complete(
            {
              assessments: admittedSnapshotIds.flatMap((snapshotId) =>
                remap(EXAMPLE.assessments, {
                  ...idsForClaim(claim.id, claim.documentId, snapshotId),
                  [EXAMPLE.assessments[0]!.id]: `assess_${claim.id}_${snapshotId}`,
                }),
              ),
              sufficiency: [
                {
                  claimId: claim.id,
                  sufficient: !this.requireTargetedRound || invocation > 1,
                  missing:
                    !this.requireTargetedRound || invocation > 1
                      ? []
                      : ["independent_origin" as const],
                  suggestedQueries: [],
                  independentOriginCount: 1,
                  unknownDependenceCount: 0,
                },
              ],
            },
            1,
          );
        },
      traceOrigins:
        (usage) =>
        async ({ claims, assessments }, environment) => {
          await enter("trace_origins", environment, usage);
          const ids = idsForClaim(claims[0]!.id, claims[0]!.documentId, assessments[0]!.snapshotId);
          const newSnapshotIds: string[] = [];
          if (this.provenanceSuffix !== null) {
            const archived = evidenceSnapshot(this.provenanceSuffix);
            await environment.ports.snapshots.put(archived, environment.signal);
            newSnapshotIds.push(archived.id);
          }
          return complete({ graphs: remap(EXAMPLE.provenance, ids), newSnapshotIds }, 1);
        },
      adjudicateClaims:
        (usage) =>
        async ({ claims, assessments }, environment) => {
          await enter("adjudicate_claims", environment, usage);
          const first = assessments[0]!;
          const ids = {
            ...idsForClaim(claims[0]!.id, claims[0]!.documentId, first.snapshotId),
            [EXAMPLE.assessments[0]!.id]: first.id,
          };
          return complete({ decisions: remap(EXAMPLE.decisions, ids) }, 1);
        },
    };
  }
}

export interface ScenarioResult {
  id: OrchestrationScenario;
  checks: string[];
}

export async function runOrchestrationScenario(id: OrchestrationScenario): Promise<ScenarioResult> {
  const checks: string[] = [];
  const check = (condition: unknown, description: string) => {
    if (!condition) throw new Error(`${id}: ${description}`);
    checks.push(description);
  };
  const world = new OrchestrationWorld();

  switch (id) {
    case "submit_disconnect_resume": {
      const { runId } = await world.submit({ kind: "text", text: ORIGINAL_ARTICLE });
      const disconnected = new AbortController();
      const firstEvent = await nextProgress(world, runId, disconnected.signal);
      disconnected.abort();
      check(firstEvent?.status === "queued", "submission returns a durable queued run");
      const afterDisconnect = await world.repository.getRunProgress({ scope: SCOPE_A, runId });
      check(
        afterDisconnect?.status === "queued" && !afterDisconnect.cancellationRequested,
        "browser disconnect does not cancel the durable job",
      );
      world.hooks.set("assess_evidence:after_provider", async (environment, invocation) => {
        if (invocation !== 1) return;
        world.stopWorker();
        await abortedSignal(environment.signal);
      });
      await world.drain([runId]).catch(() => undefined);
      const interrupted = await world.repository.getRunProgress({ scope: SCOPE_A, runId });
      check(
        interrupted?.status === "retry",
        "worker shutdown releases the job for immediate retry",
      );
      await world.drain([runId]);
      const progress = await world.repository.getRunProgress({ scope: SCOPE_A, runId });
      check(
        progress?.status === "complete" && progress.attempt === 2,
        "a second worker resumes and completes",
      );
      check(
        ["normalize_input", "extract_claims", "retrieve_evidence:0", "assess_evidence"].every(
          (stage) => world.count(stage) === (stage === "assess_evidence" ? 2 : 1),
        ) && world.count("trace_origins") === 1,
        "checkpointed stages are not re-executed and interrupted work resumes",
      );
      const reconnect = await world.report(runId);
      check(
        reconnect?.status === "complete" && reconnect.scorecard !== null,
        "reconnect reads the completed report",
      );
      return { id, checks };
    }
    case "crash_retry_same_reservation": {
      const { runId } = await world.submit({ kind: "text", text: ORIGINAL_ARTICLE });
      world.hooks.set("assess_evidence:after_provider", async (_environment, invocation) => {
        if (invocation === 1) throw new Error("fixture crash after a provider call");
      });
      await world.drain([runId]);
      const progress = await world.repository.getRunProgress({ scope: SCOPE_A, runId });
      check(
        progress?.status === "complete" && progress.attempt === 2,
        "crashed attempt is retried to completion",
      );
      check(world.providerCalls === 2, "the provider call is repeated only for the crashed stage");
      check(world.reservations.size === 1, "the retried call reuses its spend reservation");
      check(
        [...world.reservations.values()].every(({ settled }) => settled),
        "reservations settle at completion",
      );
      const stale = await world.repository
        .finalize({
          scope: SCOPE_A,
          runId,
          fencingToken: "fixture-worker:stale",
          reportHash: "stale",
          report: (await world.report(runId))!,
        })
        .then(() => false)
        .catch(() => true);
      check(stale, "a stale fencing token cannot finalize");
      const report = await world.report(runId);
      check(report?.status === "complete", "unfinished attempts are never marked complete");
      return { id, checks };
    }
    case "explicit_cancel": {
      const { runId } = await world.submit({ kind: "text", text: ORIGINAL_ARTICLE });
      world.hooks.set("retrieve_evidence:0", async (environment) => {
        await world.repository.requestCancellation({
          scope: SCOPE_A,
          runId,
          reason: "user_request",
        });
        await abortedSignal(environment.signal);
      });
      await world.drain([runId]);
      const progress = await world.repository.getRunProgress({ scope: SCOPE_A, runId });
      check(progress?.status === "canceled", "explicit cancellation propagates to the running job");
      check((await world.report(runId)) === null, "a canceled run stores no report or scorecard");
      check(world.count("assess_evidence") === 0, "no stage runs after cancellation");
      check(
        world.terminals.some((item) => item.runId === runId && item.outcome === "canceled"),
        "cancellation releases run resources through the terminal hook",
      );
      check(
        (await world.repository.requestCancellation({
          scope: SCOPE_A,
          runId,
          reason: "user_request",
        })) === false,
        "a terminal run cannot be canceled again",
      );
      return { id, checks };
    }
    case "cached_exact_repeat": {
      const first = await world.submit({ kind: "text", text: ORIGINAL_ARTICLE });
      await world.drain([first.runId]);
      const second = await world.submit({ kind: "text", text: ORIGINAL_ARTICLE });
      await world.drain([second.runId]);
      const report = await world.report(second.runId);
      check(report?.status === "complete", "an exact repeat completes");
      check(
        report?.replayManifest.runId === first.runId,
        "the repeat reuses the compatible prior report",
      );
      check(
        world.count("retrieve_evidence:0") === 1 && world.count("adjudicate_claims") === 1,
        "reuse skips evidence and verdict stages",
      );
      check(world.count("normalize_input") === 2, "the input is re-normalized before reuse");
      const forced = await world.submit(
        { kind: "text", text: ORIGINAL_ARTICLE },
        { allowReuse: false },
      );
      await world.drain([forced.runId]);
      check(world.count("adjudicate_claims") === 2, "forced reanalysis bypasses reuse");
      world.versions = { ...world.versions, model: "changed-model" };
      const changed = await world.submit({ kind: "text", text: ORIGINAL_ARTICLE });
      await world.drain([changed.runId]);
      check(
        (await world.report(changed.runId))?.replayManifest.runId === changed.runId,
        "a version change prevents reuse",
      );
      const other = await world.submit(
        { kind: "text", text: ORIGINAL_ARTICLE },
        { scope: SCOPE_B },
      );
      await world.drain([other.runId]);
      check(
        (await world.report(other.runId, SCOPE_B))?.replayManifest.runId === other.runId,
        "another owner never reuses a report",
      );
      return { id, checks };
    }
    case "url_content_change": {
      const first = await world.submit({ kind: "link", url: FIXTURE_URL });
      await world.drain([first.runId]);
      world.remote.set(FIXTURE_URL, CHANGED_ARTICLE);
      const second = await world.submit({ kind: "link", url: FIXTURE_URL });
      await world.drain([second.runId]);
      const before = await world.report(first.runId);
      const after = await world.report(second.runId);
      check(world.count("normalize_input") === 2, "the changed URL is fetched again");
      check(
        after?.replayManifest.runId === second.runId,
        "changed content is not served from the URL cache",
      );
      const primary = (report: RunReport | null) =>
        report?.snapshots.find(({ id }) => id === report.primarySnapshotId)?.contentHash;
      check(primary(before) !== primary(after), "the new report cites the new content hash");
      check(world.count("adjudicate_claims") === 2, "the changed content is fully reanalyzed");
      return { id, checks };
    }
    case "report_rendering": {
      const { runId } = await world.submit({ kind: "text", text: ORIGINAL_ARTICLE });
      await world.drain([runId]);
      const view = projectReport(await world.report(runId));
      check(view.schemaVersion === 2, "reports use the Core v2 renderer");
      check(
        view.score.label === "Supported share of resolved claims" &&
          view.score.formulaVersion !== null &&
          view.focusedSelection?.selectedClaimIds.length === 1 &&
          view.focusedPublicationPolicy?.policyVersion === "core-v2-focused-publication-1.0.0",
        "focused score shows its selected-claim scope and formula version",
      );
      check(
        view.claims.every((claim) =>
          claim.evidence.every((item) => item.excerptHref.includes(`/v2/runs/${runId}/evidence/`)),
        ),
        "evidence excerpts link to the owner-scoped evidence route",
      );
      check(
        view.visualVerification.visualProvenance === "not_verified",
        "visual provenance is never implied by OCR",
      );
      const canceled = projectReport(coreV2Examples.canceled);
      check(
        canceled.schemaVersion === 2 && canceled.score.value === null,
        "null scores render as unavailable",
      );
      return { id, checks };
    }
    case "owner_isolation": {
      const { runId } = await world.submit({ kind: "text", text: ORIGINAL_ARTICLE });
      await world.drain([runId]);
      const report = await world.report(runId);
      const evidenceId = report?.snapshots.find(({ role }) => role === "evidence")?.id ?? "";
      check(
        (await world.repository.getRunProgress({ scope: SCOPE_B, runId })) === null,
        "progress is hidden from other owners",
      );
      check((await world.report(runId, SCOPE_B)) === null, "reports are hidden from other owners");
      check(
        (await world.repository.getSnapshot({ scope: SCOPE_B, snapshotId: evidenceId })) === null,
        "evidence is hidden from other owners",
      );
      check(
        (await world.repository.requestCancellation({
          scope: SCOPE_B,
          runId,
          reason: "user_request",
        })) === false,
        "other owners cannot cancel a run",
      );
      return { id, checks };
    }
    case "checkpoint_invalidation": {
      const engine = (attempt: number, versions: RunContext["versions"]) =>
        runEngineDirectly(world, attempt, versions);
      await engine(1, world.versions);
      const baseline = new Map(world.calls);
      await engine(2, world.versions);
      check(
        [...world.calls].every(([name, count]) => baseline.get(name) === count),
        "unchanged configuration restores every checkpoint",
      );
      await engine(3, { ...world.versions, retriever: "changed-retriever" });
      check(
        world.count("normalize_input") === 2 && world.count("adjudicate_claims") === 2,
        "changed configuration invalidates downstream checkpoints",
      );
      world.repository.checkpoints.delete(
        `${runContextExample.tenantId}|${runContextExample.ownerUserId}|${runContextExample.visibility}|run_checkpoint_fixture|retrieve_evidence`,
      );
      const unchangedEvidence = await engine(4, {
        ...world.versions,
        retriever: "changed-retriever",
      });
      check(
        world.count("retrieve_evidence:0") === 3 &&
          world.count("assess_evidence") === 2 &&
          world.count("trace_origins") === 2,
        "a rerun that yields identical evidence keeps downstream checkpoints",
      );
      world.repository.checkpoints.delete(
        `${runContextExample.tenantId}|${runContextExample.ownerUserId}|${runContextExample.visibility}|run_checkpoint_fixture|retrieve_evidence`,
      );
      world.evidenceSuffix = " Operations continued in 2026.";
      const changedEvidence = await engine(5, {
        ...world.versions,
        retriever: "changed-retriever",
      });
      check(
        world.count("normalize_input") === 2 && world.count("retrieve_evidence:0") === 4,
        "changed evidence re-executes from retrieval without re-normalizing input",
      );
      check(
        world.count("assess_evidence") === 3 &&
          world.count("trace_origins") === 3 &&
          world.count("adjudicate_claims") === 3,
        "changed evidence invalidates downstream assessment, provenance and adjudication checkpoints",
      );
      check(
        changedEvidence.report?.evidenceSetHash !== null &&
          changedEvidence.report?.evidenceSetHash !== unchangedEvidence.report?.evidenceSetHash,
        "the frozen evidence-set hash changes with the evidence",
      );
      return { id, checks };
    }
    case "shared_run_budget": {
      world.retrievalRequests = 119;
      const result = await runEngineDirectly(world, null, world.versions);
      const assess = world.usage.get("assess_evidence")?.[0];
      check(
        assess?.priorExternalRequests === 120,
        "later stages receive the run's prior external requests",
      );
      check(
        assess?.remainingExternalRequests === 0,
        "no stage receives a fresh copy of the run budget",
      );
      check(
        result.report?.cost.externalRequests !== undefined &&
          result.report.cost.externalRequests >= 120,
        "run cost sums every stage",
      );
      check(result.status === "partial", "an over-budget stage cannot produce a complete run");
      return { id, checks };
    }
    case "deterministic_replay": {
      world.calibratorArtifact = null;
      const { runId } = await world.submit({ kind: "text", text: ORIGINAL_ARTICLE });
      await world.drain([runId]);
      const report = (await world.report(runId))!;
      const environment = replayEnvironment(report);
      const replay = await replayAnalysisV2({
        report,
        environment,
        calibrateDecisions: createCalibrateDecisionsV2({ artifact: null }),
      });
      check(
        replay.mode === "deterministic_replay" && replay.evidenceSetHashVerified,
        "replay verifies the persisted evidence-set hash",
      );
      check(
        replay.decisionsMatch && replay.scorecardMatch,
        "replay reproduces decisions and score without model calls",
      );
      check(world.providerCalls === 1, "replay makes no provider call");
      const tampered = { ...report, evidenceSetHash: evidenceSetHash([], []) };
      const rejected = await replayAnalysisV2({
        report: tampered,
        environment,
        calibrateDecisions: createCalibrateDecisionsV2({ artifact: null }),
      })
        .then(() => false)
        .catch(() => true);
      check(rejected, "replay rejects evidence that does not match the recorded hash");
      const fixtureWorld = new OrchestrationWorld();
      const fixtureRun = await fixtureWorld.submit({ kind: "text", text: ORIGINAL_ARTICLE });
      await fixtureWorld.drain([fixtureRun.runId]);
      const fixtureReport = (await fixtureWorld.report(fixtureRun.runId))!;
      const failClosed = await replayAnalysisV2({
        report: fixtureReport,
        environment: replayEnvironment(fixtureReport),
        calibrateDecisions: createCalibrateDecisionsV2({ artifact: syntheticCalibratorArtifact() }),
      });
      check(
        failClosed.decisionsMatch &&
          failClosed.report.focusedPublicationPolicy?.calibration.status === "not_used" &&
          failClosed.report.decisions.every(
            ({ focusedPublication }) => focusedPublication?.calibration.status === "not_used",
          ),
        "focused replay uses its evidence gate and never manufactures calibration",
      );
      return { id, checks };
    }
    case "targeted_sufficiency_round": {
      world.requireTargetedRound = true;
      const result = await runEngineDirectly(world, null, world.versions);
      check(
        world.count("retrieve_evidence:1") === 1,
        "insufficient evidence triggers one targeted retrieval round",
      );
      check(
        world.count("assess_evidence") === 2,
        "targeted evidence is assessed before adjudication",
      );
      check(
        result.report?.assessments.length === 2,
        "targeted assessments are persisted with the report",
      );
      check(
        world.usage.get("adjudicate_claims")?.[0]?.priorTargetedRounds === 1,
        "adjudication is told how many targeted rounds the run already used",
      );
      const retrieval = result.report?.stageOutcomes.find(
        ({ stage }) => stage === "retrieve_evidence",
      );
      check(
        retrieval?.metrics.externalRequests === 4,
        "targeted retrieval usage is charged to the run",
      );
      return { id, checks };
    }
    case "provenance_reassessment": {
      world.provenanceSuffix = " Archived copy.";
      const result = await runEngineDirectly(world, null, world.versions);
      check(
        world.count("assess_evidence") === 2,
        "provenance snapshots are reassessed before adjudication",
      );
      const archived = result.report?.snapshots.find(({ normalizedText }) =>
        normalizedText.endsWith("Archived copy."),
      );
      check(archived !== undefined, "provenance snapshots are persisted with the report");
      check(
        result.report?.assessments.some(({ snapshotId }) => snapshotId === archived?.id) === true,
        "the reassessment joins the frozen evidence set",
      );
      const adjudication = world.usage.get("adjudicate_claims")?.[0];
      check(
        adjudication?.priorExternalRequests === 6,
        "reassessment usage counts before adjudication",
      );
      return { id, checks };
    }
  }
}

async function runEngineDirectly(
  world: OrchestrationWorld,
  attempt: number | null,
  versions: RunContext["versions"],
) {
  const context: RunContext = {
    ...runContextExample,
    runId: "run_checkpoint_fixture",
    versions,
    inputHash: hashValue({ kind: "text", text: ORIGINAL_ARTICLE }),
  };
  const scope = scopeOf(context);
  if (attempt !== null) {
    const job = world.repository.jobs.get(context.runId);
    if (!job) {
      await world.repository.enqueue({
        context,
        stage: "normalize_input",
        payload: createCoreJobPayload(
          { kind: "text", text: ORIGINAL_ARTICLE },
          { allowReuse: false },
        ),
        maxAttempts: 10,
      });
    }
    const live = world.repository.jobs.get(context.runId)!;
    live.status = "leased";
    live.attempt = attempt;
    live.fencingToken = `direct-${attempt}`;
    live.leaseExpiresAt = world.repository.now() + 60_000;
  }
  const ports = world.ports(context.runId);
  const environment: RunEnvironment = {
    context,
    signal: new AbortController().signal,
    ports: {
      ...ports,
      snapshots: {
        put: async (snapshot) =>
          world.repository.putSnapshot({ scope, snapshot }).catch(() => undefined),
        get: async (snapshotId) => world.repository.getSnapshot({ scope, snapshotId }),
        getMany: async (snapshotIds) => world.repository.getSnapshots({ scope, snapshotIds }),
      },
      runs: {
        checkpoint: async (request) =>
          world.repository.checkpoint({ scope, ...request, stage: request.stage }),
        readCheckpoint: async (request) => world.repository.readCheckpoint({ scope, ...request }),
        finalize: async () => undefined,
      },
    },
  };
  return createRunAnalysisV2({
    stages: world.stageFactories(),
    ...(attempt === null ? {} : { attempt, fencingToken: `direct-${attempt}` }),
  })({ input: { kind: "text", text: ORIGINAL_ARTICLE }, seed: 20260910 }, environment);
}

function replayEnvironment(report: RunReport): RunEnvironment {
  const refuse = async () => {
    throw new Error("Deterministic replay must not call models, search or acquisition.");
  };
  const snapshots = new Map(report.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  return {
    context: {
      ...runContextExample,
      runId: report.runId,
      visibility: report.visibility,
      inputHash: report.replayManifest.inputHash,
      asOfTime: report.replayManifest.asOfTime,
      versions: report.replayManifest.versions,
      budget: report.replayManifest.budget,
      executionMode: "replay",
    },
    signal: new AbortController().signal,
    ports: {
      generation: { modelId: "replay", promptVersion: "replay", generate: refuse },
      embeddings: { modelId: "replay", dimensions: 1024, preprocessing: "replay", embed: refuse },
      search: [],
      documents: { acquire: refuse, acquireFromText: refuse },
      snapshots: {
        put: refuse,
        get: async (id) => snapshots.get(id) ?? null,
        getMany: async (ids) =>
          ids.flatMap((id) => (snapshots.has(id) ? [snapshots.get(id)!] : [])),
      },
      runs: { checkpoint: refuse, readCheckpoint: refuse, finalize: refuse },
      clock: { now: () => report.createdAt, monotonicMs: () => 0 },
      audit: { sinkId: "replay", record: async () => undefined },
    },
  };
}

async function nextProgress(world: OrchestrationWorld, runId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  return world.repository.getRunProgress({ scope: SCOPE_A, runId });
}

function abortedSignal(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Signal was never aborted.")), 2_000);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

function submittedSnapshot(text: string, url: string | null, acquiredAt: string): DocumentSnapshot {
  const bytes = new TextEncoder().encode(text);
  const contentHash = sha256(bytes);
  return documentSnapshotSchema.parse({
    ...EXAMPLE_INPUT,
    id: `snap_input_${hashValue({ contentHash, url }).slice(7, 23)}`,
    contentHash,
    rawContentHash: null,
    originalUrl: url,
    finalUrl: url,
    canonicalUrl: url,
    acquiredAt,
    normalizedText: text,
    limits: {
      ...EXAMPLE_INPUT.limits,
      bytesRetained: bytes.byteLength,
      charactersRetained: text.length,
    },
    locators: EXAMPLE_INPUT.locators.map((locator) => ({
      ...locator,
      span: { start: 0, end: text.length },
    })),
  });
}

function evidenceSnapshot(suffix: string): DocumentSnapshot {
  if (suffix === "")
    return documentSnapshotSchema.parse({
      ...EXAMPLE_EVIDENCE,
      blobLocator: { status: "unavailable", uri: null },
    });
  const text = `${EXAMPLE_EVIDENCE.normalizedText}${suffix}`;
  const bytes = new TextEncoder().encode(text);
  const contentHash = sha256(bytes);
  return documentSnapshotSchema.parse({
    ...EXAMPLE_EVIDENCE,
    id: `snap_evidence_${contentHash.slice(7, 23)}`,
    contentHash,
    rawContentHash: null,
    blobLocator: { status: "unavailable", uri: null },
    normalizedText: text,
    limits: {
      ...EXAMPLE_EVIDENCE.limits,
      bytesRetained: bytes.byteLength,
      charactersRetained: text.length,
    },
  });
}

function fixtureIds(primary: DocumentSnapshot) {
  return idsForClaim(`claim_${primary.id.slice("snap_input_".length)}`, primary.id);
}

function idsForClaim(
  claimId: string,
  documentId: string,
  evidenceId = EXAMPLE_EVIDENCE.id,
): Record<string, string> {
  return {
    [EXAMPLE_EVIDENCE.id]: evidenceId,
    [EXAMPLE_CLAIM_ID]: claimId,
    [EXAMPLE_INPUT.id]: documentId,
    [EXAMPLE.assessments[0]!.id]: `assess_${claimId}`,
    [EXAMPLE.candidates[0]!.id]: `cand_${claimId}`,
  };
}

function remap<Value>(value: Value, ids: Record<string, string>): Value {
  let json = JSON.stringify(value);
  for (const [from, to] of Object.entries(ids)) json = json.split(`"${from}"`).join(`"${to}"`);
  return JSON.parse(json) as Value;
}

function complete<Value>(data: Value, externalRequests: number): StageResult<Value> {
  return { status: "complete", data, issues: [], metrics: metrics(externalRequests) };
}

function unavailable(code: CoreIssue["code"], message: string): StageResult<never> {
  return {
    status: "unavailable",
    data: null,
    issues: [{ code, severity: "warning", message, claimId: null, snapshotId: null, url: null }],
    metrics: metrics(0),
  };
}

function metrics(externalRequests: number): StageMetrics {
  return {
    startedAt: runContextExample.asOfTime,
    completedAt: runContextExample.asOfTime,
    durationMs: 0,
    externalRequests,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

function sha256(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function scopeOf(
  context: Pick<RunContext, "tenantId" | "ownerUserId" | "visibility">,
): CoreAccessScope {
  return {
    tenantId: context.tenantId,
    ownerUserId: context.ownerUserId,
    visibility: context.visibility,
  };
}

function key(scope: CoreAccessScope) {
  return `${scope.tenantId}|${scope.ownerUserId}|${scope.visibility}`;
}

export type { CoreStorageRepository };
