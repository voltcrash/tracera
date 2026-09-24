const CRUD = ["DELETE", "INSERT", "SELECT", "UPDATE"];
const READ_WRITE = ["INSERT", "SELECT", "UPDATE"];
const APPEND = ["INSERT", "SELECT"];

/**
 * The complete expected table privileges of tracera_runtime after all
 * migrations. Every public table must be listed, so a new table forces an
 * explicit privilege decision and a reviewed grant migration.
 */
export const RUNTIME_TABLE_GRANTS = {
  // 0024: Better Auth adapter tables.
  users: CRUD,
  sessions: CRUD,
  accounts: CRUD,
  verifications: CRUD,
  // 0024: analysis controls and spend accounting.
  analysis_rate_limits: READ_WRITE,
  analysis_leases: READ_WRITE,
  analysis_idempotency_keys: READ_WRITE,
  analysis_daily_quotas: READ_WRITE,
  analysis_force_cooldowns: READ_WRITE,
  ai_provider_spend: READ_WRITE,
  ai_spend_reservations: READ_WRITE,
  // 0029: analysis storage.
  core_runs: READ_WRITE,
  core_jobs: READ_WRITE,
  core_outbox: READ_WRITE,
  core_stage_attempts: READ_WRITE,
  core_stage_checkpoints: READ_WRITE,
  core_snapshots: APPEND,
  core_snapshot_embeddings: APPEND,
  core_report_versions: APPEND,
  core_report_snapshots: APPEND,
  core_report_claims: ["INSERT"],
  core_evidence_assessments: ["INSERT"],
  core_provenance_edges: ["INSERT"],
  core_decisions: ["INSERT"],
};
