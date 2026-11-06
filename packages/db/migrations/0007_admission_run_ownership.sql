ALTER TABLE `analysis_leases` ADD `run_id` text REFERENCES core_runs(run_id);
--> statement-breakpoint
UPDATE core_runs SET launch_admission=json_extract(input_json,'$.admission'),
  launch_status=CASE WHEN status='queued' THEN 'unknown' ELSE 'created' END
WHERE launch_admission IS NULL AND json_extract(input_json,'$.admission.leaseId') IS NOT NULL
  AND EXISTS(SELECT 1 FROM analysis_leases WHERE id=json_extract(core_runs.input_json,'$.admission.leaseId')
    AND user_id=core_runs.owner_user_id AND released_at IS NULL);
--> statement-breakpoint
UPDATE analysis_leases SET run_id=(SELECT run_id FROM core_runs
  WHERE owner_user_id=analysis_leases.user_id AND json_extract(launch_admission,'$.leaseId')=analysis_leases.id
    AND json_extract(launch_admission,'$.endpoint')=analysis_leases.endpoint
    AND json_extract(launch_admission,'$.idempotencyKey')=analysis_leases.idempotency_key)
WHERE released_at IS NULL;
--> statement-breakpoint
UPDATE analysis_idempotency_keys SET request_status='accepted'
WHERE request_status='in_progress' AND EXISTS(SELECT 1 FROM analysis_leases
  WHERE id=analysis_idempotency_keys.lease_id AND user_id=analysis_idempotency_keys.user_id
    AND endpoint=analysis_idempotency_keys.endpoint AND idempotency_key=analysis_idempotency_keys.idempotency_key
    AND run_id IS NOT NULL AND released_at IS NULL);
