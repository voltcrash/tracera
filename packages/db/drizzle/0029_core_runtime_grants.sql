-- Core v2 storage runs as tracera_runtime, but 0027 created its tables after
-- 0024 revoked default privileges. These grants mirror the statements in
-- packages/db/src/core/repository.ts. The runtime never deletes Core rows.

-- Leased state: ON CONFLICT, FOR UPDATE, and fenced status transitions.
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.core_runs,
           public.core_jobs,
           public.core_outbox,
           public.core_stage_attempts,
           public.core_stage_checkpoints
  TO tracera_runtime;

-- Immutable content read back for idempotency checks or RETURNING clauses.
GRANT SELECT, INSERT
  ON TABLE public.core_snapshots,
           public.core_snapshot_embeddings,
           public.core_report_versions,
           public.core_report_snapshots
  TO tracera_runtime;

-- Report rows written once during finalization and never read by the runtime.
GRANT INSERT
  ON TABLE public.core_report_claims,
           public.core_evidence_assessments,
           public.core_provenance_edges,
           public.core_decisions
  TO tracera_runtime;
