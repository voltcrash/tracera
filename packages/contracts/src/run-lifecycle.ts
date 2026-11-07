export const terminalRunStatuses = [
  "complete",
  "partial",
  "unavailable",
  "failed",
  "canceled",
] as const;
export const runLifecycleStatuses = ["queued", "running", ...terminalRunStatuses] as const;
export type RunLifecycleStatus = (typeof runLifecycleStatuses)[number];

export function isTerminalRunStatus(
  status: string,
): status is (typeof terminalRunStatuses)[number] {
  return terminalRunStatuses.some((value) => value === status);
}

export function isRunLifecycleStatus(status: unknown): status is RunLifecycleStatus {
  return runLifecycleStatuses.some((value) => value === status);
}
