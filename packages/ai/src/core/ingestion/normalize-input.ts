import type { CoreIssue, StageMetrics } from "@repo/contracts/core-v2";
import type { NormalizeInputV2 } from "../types";
import { supportsImageAcquisition } from "./types";

export const normalizeInputV2: NormalizeInputV2 = async ({ input }, environment) => {
  const { clock, documents, audit } = environment.ports;
  const startedAt = clock.now();
  const startedMs = clock.monotonicMs();
  await audit.record({
    runId: environment.context.runId,
    stage: "normalize_input",
    kind: "stage_started",
    message: "Input acquisition started.",
    claimId: null,
    snapshotId: null,
    at: startedAt,
  });
  if (environment.signal.aborted || environment.context.cancellation.requested) {
    const issue = cancellationIssue();
    await audit.record({
      runId: environment.context.runId,
      stage: "normalize_input",
      kind: "cancellation",
      message: issue.message,
      claimId: null,
      snapshotId: null,
      at: clock.now(),
    });
    return {
      status: "failed",
      data: null,
      issues: [issue],
      metrics: stageMetrics(clock, startedAt, startedMs, 0),
    };
  }

  let result;
  try {
    result =
      input.kind === "text"
        ? await documents.acquireFromText({
            text: input.text,
            role: "submitted_input",
            signal: environment.signal,
          })
        : input.kind === "link"
          ? await documents.acquire({
              url: input.url,
              role: "submitted_input",
              maxBytes: 5_000_000,
              signal: environment.signal,
            })
          : supportsImageAcquisition(documents)
            ? await documents.acquireImage({
                data: input.data,
                mimeType: input.mimeType,
                caption: input.caption,
                role: "submitted_input",
                maxBytes: 20_000_000,
                signal: environment.signal,
              })
            : {
                status: "unavailable" as const,
                data: null,
                issues: [
                  {
                    code: "capability_unavailable" as const,
                    severity: "warning" as const,
                    message: "The configured document acquisition port cannot acquire images.",
                    claimId: null,
                    snapshotId: null,
                    url: null,
                  },
                ],
                metrics: stageMetrics(clock, startedAt, startedMs, 0),
              };
  } catch (error) {
    if (!environment.signal.aborted) throw error;
    const issue = cancellationIssue();
    await finishAudit(environment, "failed", null);
    return {
      status: "failed",
      data: null,
      issues: [issue],
      metrics: stageMetrics(clock, startedAt, startedMs, 0),
    };
  }

  if (!result.data) {
    await finishAudit(environment, result.status, null);
    return {
      status: result.status,
      data: null,
      issues: result.issues,
      metrics: result.metrics,
    };
  }
  await environment.ports.snapshots.put(result.data.snapshot, environment.signal);
  await finishAudit(environment, result.status, result.data.snapshot.id);
  return {
    status: result.status,
    data: {
      snapshots: [result.data.snapshot],
      primarySnapshotId: result.data.snapshot.id,
    },
    issues: result.issues,
    metrics: result.metrics,
  };
};

async function finishAudit(
  environment: Parameters<NormalizeInputV2>[1],
  status: string,
  snapshotId: string | null,
) {
  await environment.ports.audit.record({
    runId: environment.context.runId,
    stage: "normalize_input",
    kind: "stage_finished",
    message: `Input acquisition finished with status ${status}.`,
    claimId: null,
    snapshotId,
    at: environment.ports.clock.now(),
  });
}

function cancellationIssue(): CoreIssue {
  return {
    code: "cancellation_requested",
    severity: "warning",
    message: "Input acquisition was canceled before it started.",
    claimId: null,
    snapshotId: null,
    url: null,
  };
}

function stageMetrics(
  clock: Parameters<NormalizeInputV2>[1]["ports"]["clock"],
  startedAt: string,
  startedMs: number,
  externalRequests: number,
): StageMetrics {
  return {
    startedAt,
    completedAt: clock.now(),
    durationMs: Math.max(0, clock.monotonicMs() - startedMs),
    externalRequests,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}
