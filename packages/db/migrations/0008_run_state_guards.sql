UPDATE core_runs SET finalized_at=updated_at
WHERE status NOT IN ('queued','running') AND finalized_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER core_runs_insert_state_guard BEFORE INSERT ON core_runs
WHEN ((NEW.status IN ('queued','running')) <> (NEW.finalized_at IS NULL))
  OR ((NEW.attempt=0) <> (NEW.fencing_token IS NULL))
  OR (NEW.status='queued' AND NEW.attempt<>0)
  OR (NEW.status='running' AND NEW.attempt=0)
BEGIN SELECT RAISE(ABORT, 'Invalid run lifecycle state'); END;
--> statement-breakpoint
CREATE TRIGGER core_runs_update_state_guard BEFORE UPDATE ON core_runs
WHEN ((NEW.status IN ('queued','running')) <> (NEW.finalized_at IS NULL))
  OR ((NEW.attempt=0) <> (NEW.fencing_token IS NULL))
  OR (NEW.status='queued' AND NEW.attempt<>0)
  OR (NEW.status='running' AND NEW.attempt=0)
  OR (OLD.finalized_at IS NOT NULL AND (NEW.status<>OLD.status OR NEW.finalized_at IS NOT OLD.finalized_at
    OR NEW.attempt<>OLD.attempt OR NEW.fencing_token IS NOT OLD.fencing_token))
BEGIN SELECT RAISE(ABORT, 'Invalid run lifecycle transition'); END;
--> statement-breakpoint
CREATE TRIGGER core_stage_attempts_insert_state_guard BEFORE INSERT ON core_stage_attempts
WHEN ((NEW.finished_at IS NULL) <> (NEW.outcome IS NULL))
  OR (NEW.outcome IS NOT NULL AND NEW.outcome NOT IN ('complete','failed','canceled'))
BEGIN SELECT RAISE(ABORT, 'Invalid attempt lifecycle state'); END;
--> statement-breakpoint
CREATE TRIGGER core_stage_attempts_update_state_guard BEFORE UPDATE ON core_stage_attempts
WHEN ((NEW.finished_at IS NULL) <> (NEW.outcome IS NULL))
  OR (NEW.outcome IS NOT NULL AND NEW.outcome NOT IN ('complete','failed','canceled'))
  OR (OLD.finished_at IS NOT NULL AND (NEW.finished_at IS NOT OLD.finished_at OR NEW.outcome IS NOT OLD.outcome))
BEGIN SELECT RAISE(ABORT, 'Invalid attempt lifecycle transition'); END;
