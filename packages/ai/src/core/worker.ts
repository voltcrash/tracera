import type { DocumentSnapshot, RunStatus } from "@repo/contracts/core-v2";
import type { CoreScopedLease, CoreStorageRepository } from "@repo/db/core";
import { canonicalJson } from "./hashing.js";
import type { CoreJobPayload } from "./job.js";
import { createRunAnalysisV2, type RunAnalysisV2Options } from "./run-analysis.js";
import { createRunStore, createSnapshotStore, type RawBlobStore } from "./storage.js";
import type { CorePorts, RunAnalysisV2Input, RunEnvironment } from "./types.js";

export type DurableCoreLease = CoreScopedLease;

export type CoreWorkerRepository = Pick<
  CoreStorageRepository,
  | "acquireNextLease"
  | "renewLease"
  | "retry"
  | "acknowledgeCancellation"
  | "getRunProgress"
  | "findLatestCompletedReport"
  | "checkpoint"
  | "readCheckpoint"
  | "finalize"
  | "putSnapshot"
  | "getSnapshot"
  | "getSnapshots"
>;

export type CoreTerminalOutcome = RunStatus;

export interface CoreWorkerOptions {
  repository: CoreWorkerRepository;
  workerId: string;
  leaseSeconds: number;
  idleMs?: number;
  retryBackoffMs?: number;
  cancellationPollMs?: number;
  /** Omit to disable report reuse; similar content is never offered as a candidate. */
  reuseMaxAgeMs?: number;
  signal: AbortSignal;
  blobStore?: RawBlobStore;
  createPorts(input: {
    lease: DurableCoreLease;
    snapshots: CorePorts["snapshots"];
    runs: CorePorts["runs"];
    signal: AbortSignal;
  }): Omit<CorePorts, "snapshots" | "runs">;
  engineOptions?: Omit<RunAnalysisV2Options, "attempt" | "fencingToken" | "reuse">;
  onError?: (error: unknown, lease: DurableCoreLease | null) => void;
  onTerminal?: (lease: DurableCoreLease, outcome: CoreTerminalOutcome) => Promise<void>;
}

class LeaseInterrupted extends Error {
  constructor(readonly kind: "cancellation" | "lease_lost") {
    super(kind === "cancellation" ? "Cancellation was requested." : "The job lease was lost.");
  }
}

export async function runCoreWorker(options: CoreWorkerOptions) {
  const idleMs = options.idleMs ?? 250;
  const retryBackoffMs = options.retryBackoffMs ?? 1_000;
  const cancellationPollMs = options.cancellationPollMs ?? 1_000;
  if (options.leaseSeconds < 1 || idleMs < 0 || retryBackoffMs < 0 || cancellationPollMs < 1)
    throw new RangeError("Worker lease must be positive and delays must be non-negative.");

  while (!options.signal.aborted) {
    let lease: DurableCoreLease | null = null;
    try {
      lease = await options.repository.acquireNextLease({
        workerId: options.workerId,
        leaseSeconds: options.leaseSeconds,
      });
    } catch (error) {
      options.onError?.(error, null);
      await abortableDelay(idleMs, options.signal);
      continue;
    }
    if (!lease) {
      await abortableDelay(idleMs, options.signal);
      continue;
    }
    await processLease(options, lease, retryBackoffMs, cancellationPollMs);
  }
}

async function processLease(
  options: CoreWorkerOptions,
  lease: DurableCoreLease,
  retryBackoffMs: number,
  cancellationPollMs: number,
) {
  const identity = {
    scope: lease.scope,
    runId: lease.runId,
    stage: lease.stage,
    attempt: lease.attempt,
    fencingToken: lease.fencingToken,
  };
  const acknowledgeCancellation = async () => {
    try {
      await options.repository.acknowledgeCancellation(identity);
      await options.onTerminal?.(lease, "canceled");
    } catch (error) {
      options.onError?.(error, lease);
    }
  };
  if (lease.cancellationRequested) return acknowledgeCancellation();

  const runController = new AbortController();
  const signal = AbortSignal.any([options.signal, runController.signal]);
  const interrupt = (kind: LeaseInterrupted["kind"]) => {
    if (!runController.signal.aborted) runController.abort(new LeaseInterrupted(kind));
  };
  const renewTimer = setInterval(
    () => {
      void options.repository
        .renewLease({ ...identity, leaseSeconds: options.leaseSeconds })
        .catch(async () =>
          interrupt((await cancellationRequested()) ? "cancellation" : "lease_lost"),
        );
    },
    Math.max(1_000, Math.floor((options.leaseSeconds * 1_000) / 3)),
  );
  const cancellationTimer = setInterval(() => {
    void cancellationRequested().then((requested) => {
      if (requested) interrupt("cancellation");
    });
  }, cancellationPollMs);
  async function cancellationRequested() {
    try {
      const progress = await options.repository.getRunProgress({
        scope: lease.scope,
        runId: lease.runId,
      });
      return progress?.cancellationRequested === true;
    } catch {
      return false;
    }
  }

  try {
    const payload = parsePayload(lease.payload);
    const snapshots = acceptStoredSnapshots(
      createSnapshotStore({
        repository: options.repository,
        context: lease.context,
        blobStore: options.blobStore,
      }),
    );
    const runs = createRunStore({ repository: options.repository, context: lease.context });
    const environment: RunEnvironment = {
      context: lease.context,
      ports: { ...options.createPorts({ lease, snapshots, runs, signal }), snapshots, runs },
      signal,
    };
    const result = await createRunAnalysisV2({
      ...options.engineOptions,
      attempt: lease.attempt,
      fencingToken: lease.fencingToken,
      ...(payload.allowReuse && options.reuseMaxAgeMs !== undefined
        ? {
            reuse: {
              maxAgeMs: options.reuseMaxAgeMs,
              findCandidate: ({ inputHash }) =>
                options.repository.findLatestCompletedReport({ scope: lease.scope, inputHash }),
            },
          }
        : {}),
    })(payload.analysis, environment);
    if (options.signal.aborted) {
      throw options.signal.reason ?? new Error("Worker shut down before completion.");
    }
    if (result.status === "canceled" || (await cancellationRequested())) {
      return await acknowledgeCancellation();
    }
    if (!result.report) throw new Error("The engine returned no report for a terminal run.");
    await runs.finalize({
      runId: lease.runId,
      fencingToken: lease.fencingToken,
      report: result.report,
      signal,
    });
    await options.onTerminal?.(lease, result.status);
  } catch (error) {
    const reason = runController.signal.reason;
    if (reason instanceof LeaseInterrupted && reason.kind === "lease_lost") {
      options.onError?.(reason, lease);
      return;
    }
    if (
      (reason instanceof LeaseInterrupted && reason.kind === "cancellation") ||
      (await cancellationRequested())
    ) {
      return await acknowledgeCancellation();
    }
    const shutdown = options.signal.aborted;
    if (!shutdown) options.onError?.(error, lease);
    try {
      const retried = await options.repository.retry({
        ...identity,
        error: shutdown
          ? "Worker shut down before completion."
          : error instanceof Error
            ? error.message.slice(0, 2_000)
            : "Worker failure",
        backoffMs: shutdown ? 0 : retryBackoffMs,
      });
      if (retried.terminal) await options.onTerminal?.(lease, "failed");
    } catch (retryError) {
      options.onError?.(retryError, lease);
    }
  } finally {
    clearInterval(renewTimer);
    clearInterval(cancellationTimer);
  }
}

/**
 * Snapshot IDs are derived from content and URLs, but each acquisition records its own
 * acquisition time. A repeat acquisition of identical text is the same immutable document,
 * so it is accepted without rewriting; any content difference under one ID is rejected.
 */
export function acceptStoredSnapshots(store: CorePorts["snapshots"]): CorePorts["snapshots"] {
  const sameDocument = async (snapshot: DocumentSnapshot, signal: AbortSignal) => {
    const existing = await store.get(snapshot.id, signal);
    if (!existing) return false;
    const { acquiredAt: _existingAcquiredAt, ...existingIdentity } = existing;
    const { acquiredAt: _nextAcquiredAt, ...nextIdentity } = snapshot;
    if (canonicalJson(existingIdentity) !== canonicalJson(nextIdentity))
      throw new Error(`Snapshot ${snapshot.id} is already stored with different content.`);
    Object.assign(snapshot, existing);
    return true;
  };
  return {
    get: (id, signal) => store.get(id, signal),
    getMany: (ids, signal) => store.getMany(ids, signal),
    async put(snapshot, signal) {
      if (await sameDocument(snapshot, signal)) return;
      try {
        await store.put(snapshot, signal);
      } catch (error) {
        if (await sameDocument(snapshot, signal)) return;
        throw error;
      }
    },
  };
}

function parsePayload(payload: unknown): { analysis: RunAnalysisV2Input; allowReuse: boolean } {
  if (!payload || typeof payload !== "object") throw new Error("Durable job payload is invalid.");
  const value = payload as Partial<CoreJobPayload>;
  if (
    !Number.isInteger(value.seed) ||
    (value.seed ?? -1) < 0 ||
    !value.input ||
    typeof value.allowReuse !== "boolean"
  )
    throw new Error("Durable job payload is invalid.");
  return { analysis: { input: value.input, seed: value.seed! }, allowReuse: value.allowReuse };
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
