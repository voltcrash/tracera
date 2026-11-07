import { isRunLifecycleStatus, isTerminalRunStatus } from "@repo/contracts/run-lifecycle";
import type { RunViewState } from "../server/run-view.server";

export type RunProgressState = {
  view: RunViewState;
  connection: "connecting" | "live" | "reconnecting" | "closed" | "access_lost";
  cancellation: { status: "idle" | "pending" | "requested" } | { status: "failed"; error: string };
};

export type ProgressEvent =
  | { type: "progress"; view: RunViewState }
  | { type: "connection"; status: RunProgressState["connection"] }
  | { type: "cancel_start" }
  | { type: "cancel_accepted" }
  | { type: "cancel_failed"; error: string };

export function transitionProgress(
  state: RunProgressState,
  event: ProgressEvent,
): RunProgressState {
  if (state.connection === "access_lost") return state;
  const terminal = isTerminalRunStatus(state.view.progress.status);
  switch (event.type) {
    case "progress": {
      if (
        terminal ||
        event.view.progress.runId !== state.view.progress.runId ||
        event.view.progress.version < state.view.progress.version
      )
        return state;
      if (event.view.progress.version === state.view.progress.version)
        return { ...state, connection: "live" };
      return {
        ...state,
        view: event.view,
        connection: "live",
        cancellation: isTerminalRunStatus(event.view.progress.status)
          ? { status: "idle" }
          : event.view.progress.cancellationRequested
            ? { status: "requested" }
            : state.cancellation,
      };
    }
    case "connection":
      return terminal
        ? state
        : {
            ...state,
            connection: event.status,
            cancellation: event.status === "access_lost" ? { status: "idle" } : state.cancellation,
          };
    case "cancel_start":
      return terminal ||
        state.view.progress.cancellationRequested ||
        state.cancellation.status === "requested" ||
        state.cancellation.status === "pending"
        ? state
        : { ...state, cancellation: { status: "pending" } };
    case "cancel_accepted":
      return terminal ? state : { ...state, cancellation: { status: "requested" } };
    case "cancel_failed":
      return terminal || state.view.progress.cancellationRequested
        ? state
        : { ...state, cancellation: { status: "failed", error: event.error } };
  }
}

export function decodeProgress(data: string, runId: string): RunViewState | null {
  try {
    const value = JSON.parse(data) as RunViewState | null;
    const progress = value?.progress;
    if (
      !progress ||
      progress.runId !== runId ||
      !Number.isSafeInteger(progress.version) ||
      progress.version < 0 ||
      !isRunLifecycleStatus(progress.status) ||
      !Number.isSafeInteger(progress.attempt) ||
      !Array.isArray(progress.recordedStages) ||
      !progress.recordedStages.every((stage) => typeof stage === "string") ||
      (progress.currentStage !== null && typeof progress.currentStage !== "string") ||
      typeof progress.cancellationRequested !== "boolean" ||
      (value.report !== null && (value.report?.schemaVersion !== 2 || value.report.runId !== runId))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function progressHeadline(
  progress: RunViewState["progress"],
  cancellationRequested = false,
) {
  if (progress.status === "canceled") return "Analysis canceled";
  if (progress.status === "failed") return "Analysis could not finish";
  if (progress.status === "partial") return "Analysis completed with limitations";
  if (progress.status === "unavailable") return "Analysis unavailable";
  if (progress.status === "complete") return "Analysis complete";
  if (progress.cancellationRequested || cancellationRequested) return "Cancellation requested";
  if (progress.publicationPending) return "Publishing report";
  if (progress.status === "queued") return "Queued";
  return progress.currentStage
    ? `Stage: ${progress.currentStage.replaceAll("_", " ")}`
    : "Preparing report";
}
