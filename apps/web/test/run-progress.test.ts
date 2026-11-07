import { expect, test } from "vite-plus/test";
import {
  decodeProgress,
  progressHeadline,
  transitionProgress,
  type RunProgressState,
} from "../src/lib/run-progress";
import type { RunViewState } from "../src/server/run-view.server";

const view = (version: number, changes: Partial<RunViewState["progress"]> = {}): RunViewState => ({
  progress: {
    runId: "run",
    status: "running",
    stage: "normalize_input",
    currentStage: "normalize_input",
    attempt: 1,
    version,
    cancellationRequested: false,
    publicationPending: false,
    recordedStages: [],
    completedStages: [],
    lastCheckpointedStage: null,
    nextStage: "normalize_input",
    updatedAt: "2026-11-07T00:00:00.000Z",
    ...changes,
  },
  report: null,
});
const initial = (): RunProgressState => ({
  view: view(2),
  connection: "live",
  cancellation: { status: "idle" },
});

test("old, duplicate and foreign progress cannot roll back a run, including after termination", () => {
  let state = initial();
  state = transitionProgress(state, {
    type: "progress",
    view: view(3, { currentStage: "assess_evidence" }),
  });
  for (const update of [view(2), view(3), view(4, { runId: "other" })]) {
    state = transitionProgress(state, { type: "progress", view: update });
    expect(state.view.progress.currentStage).toBe("assess_evidence");
  }
  state = transitionProgress(state, { type: "progress", view: view(4, { status: "failed" }) });
  state = transitionProgress(state, { type: "progress", view: view(5) });
  state = transitionProgress(state, { type: "cancel_failed", error: "Late failure" });
  expect(state.view.progress.status).toBe("failed");
  expect(state.cancellation.status).toBe("idle");
});

test("progress does not erase a cancellation failure or acknowledged cancellation", () => {
  let state = transitionProgress(initial(), { type: "cancel_start" });
  expect(transitionProgress(state, { type: "cancel_start" })).toBe(state);
  state = transitionProgress(state, { type: "cancel_failed", error: "Try again" });
  state = transitionProgress(state, { type: "progress", view: view(3) });
  expect(state.cancellation).toEqual({ status: "failed", error: "Try again" });
  state = transitionProgress(state, { type: "cancel_start" });
  state = transitionProgress(state, { type: "cancel_accepted" });
  state = transitionProgress(state, { type: "progress", view: view(4) });
  expect(state.cancellation.status).toBe("requested");
  expect(state.view.progress.version).toBe(4);
});

test("access loss is permanent for the current stream and malformed frames cannot update progress", () => {
  const state = transitionProgress(
    { ...initial(), cancellation: { status: "failed", error: "Try again" } },
    { type: "connection", status: "access_lost" },
  );
  expect(state.cancellation.status).toBe("idle");
  expect(transitionProgress(state, { type: "cancel_failed", error: "Late failure" })).toBe(state);
  expect(transitionProgress(state, { type: "progress", view: view(3) })).toBe(state);
  for (const data of [
    "{",
    "null",
    "{}",
    JSON.stringify(view(-1)),
    JSON.stringify(view(3, { runId: "other" })),
  ]) {
    expect(decodeProgress(data, "run")).toBeNull();
  }
  expect(decodeProgress(JSON.stringify(view(3)), "run")).toEqual(view(3));
});

test("queued, preparing, publishing, canceled and completed runs have distinct headlines", () => {
  expect(progressHeadline(view(1, { status: "queued" }).progress)).toBe("Queued");
  expect(progressHeadline(view(1, { currentStage: null }).progress)).toBe("Preparing report");
  expect(progressHeadline(view(1, { publicationPending: true }).progress)).toBe(
    "Publishing report",
  );
  expect(progressHeadline(view(1, { publicationPending: true }).progress, true)).toBe(
    "Cancellation requested",
  );
  expect(progressHeadline(view(1, { status: "complete" }).progress)).toBe("Analysis complete");
});
