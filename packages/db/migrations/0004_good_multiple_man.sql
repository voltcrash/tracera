DROP INDEX `core_runs_owner_created_idx`;--> statement-breakpoint
CREATE INDEX `core_runs_owner_created_idx` ON `core_runs` (`tenant_id`,`owner_user_id`,`visibility`,`created_at`,`run_id`);