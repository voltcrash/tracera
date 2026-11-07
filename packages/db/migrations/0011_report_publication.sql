ALTER TABLE `core_runs` ADD `prepared_report` text;
--> statement-breakpoint
CREATE TRIGGER core_runs_insert_prepared_report_guard BEFORE INSERT ON core_runs
WHEN NEW.prepared_report IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Reports require an active fenced attempt'); END;
--> statement-breakpoint
CREATE TRIGGER core_runs_update_prepared_report_guard BEFORE UPDATE ON core_runs
WHEN (NEW.prepared_report IS NOT NULL AND CASE WHEN json_valid(NEW.prepared_report) THEN
  COALESCE(json_type(NEW.prepared_report,'$.reportUri')<>'text'
    OR length(json_extract(NEW.prepared_report,'$.reportUri'))=0
    OR json_type(NEW.prepared_report,'$.reportHash')<>'text'
    OR length(json_extract(NEW.prepared_report,'$.reportHash'))=0
    OR json_extract(NEW.prepared_report,'$.status') NOT IN ('complete','partial','unavailable')
    OR json_extract(NEW.prepared_report,'$.fencingToken') IS NOT NEW.fencing_token,1)
  ELSE 1 END)
  OR (OLD.prepared_report IS NULL AND NEW.prepared_report IS NOT NULL
    AND (OLD.status<>'running' OR OLD.finalized_at IS NOT NULL OR json_extract(OLD.cancellation,'$.requested')=1))
  OR (OLD.prepared_report IS NOT NULL AND (NEW.prepared_report IS NOT OLD.prepared_report
    OR NEW.fencing_token IS NOT OLD.fencing_token OR NEW.status='failed'))
BEGIN SELECT RAISE(ABORT, 'Invalid report publication transition'); END;
