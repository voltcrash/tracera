import type { AnalysisIssue } from "@repo/contracts/analysis";
import type { RunEnvironment } from "./types";

type RunStopReason = "cancellation_requested" | "timeout" | "budget_exhausted";

export function signalStopReason(signal: AbortSignal): RunStopReason | null {
  if (!signal.aborted) return null;
  return signal.reason?.name === "TimeoutError" ? "timeout" : "cancellation_requested";
}

export function runStopReason(environment: RunEnvironment): RunStopReason | null {
  const cancellation = environment.context.cancellation;
  if (cancellation.requested) {
    if (cancellation.reason === "timeout" || cancellation.reason === "budget_exhausted")
      return cancellation.reason;
    return "cancellation_requested";
  }
  return signalStopReason(environment.signal);
}

export function isRunInterrupted(environment: RunEnvironment): boolean {
  return runStopReason(environment) !== null;
}

export function stopIssue(environment: RunEnvironment, cancellationMessage: string): AnalysisIssue {
  const code = runStopReason(environment);
  if (!code) throw new Error("The run has not been interrupted.");
  return {
    code,
    severity: "warning",
    message:
      code === "timeout"
        ? "The analysis deadline elapsed."
        : code === "budget_exhausted"
          ? "The analysis budget was exhausted."
          : cancellationMessage,
    claimId: null,
    snapshotId: null,
    url: null,
  };
}

export function stopAuditKind(environment: RunEnvironment): "cancellation" | "budget_consumed" {
  return runStopReason(environment) === "cancellation_requested"
    ? "cancellation"
    : "budget_consumed";
}
