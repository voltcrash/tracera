/**
 * Workflow params persist for the retention period, so they carry identifiers only:
 * never API keys, raw input or uploads (D14).
 */
export type AnalysisWorkflowParams = {
  runId: string;
  ownerUserId: string;
  admission: { endpoint: string; idempotencyKey: string; leaseId: string };
};
