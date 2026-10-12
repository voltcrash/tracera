/**
 * Workflow params persist for the retention period, so they carry identifiers only:
 * never API keys, raw input or uploads (D14).
 */
export type AnalysisWorkflowParams = {
  runId: string;
  ownerUserId: string;
  admission: { endpoint: string; idempotencyKey: string; leaseId: string };
};

export const ANALYSIS_WORKFLOW_RETRIES = 2;
export const WORKFLOW_SETTLEMENT_CONFIG = {
  retries: { limit: ANALYSIS_WORKFLOW_RETRIES, delay: "2 seconds", backoff: "exponential" },
  timeout: 30_000,
} as const;

export function workflowAdmissionLeaseSeconds(configuredSeconds: number, maxElapsedMs: number) {
  // Three analysis attempts plus bounded failure/finalize/release retries, without lease timers.
  return Math.max(
    configuredSeconds,
    Math.ceil(((ANALYSIS_WORKFLOW_RETRIES + 1) * maxElapsedMs + 300_000) / 1_000),
  );
}
