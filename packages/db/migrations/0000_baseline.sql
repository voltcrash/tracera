CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_user_id_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_account_idx` ON `accounts` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `ai_provider_spend` (
	`provider_key` text NOT NULL,
	`key_source` text NOT NULL,
	`period_start` text NOT NULL,
	`budget_micros` integer NOT NULL,
	`reserved_micros` integer DEFAULT 0 NOT NULL,
	`actual_micros` integer DEFAULT 0 NOT NULL,
	`open_until` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`provider_key`, `key_source`, `period_start`),
	CONSTRAINT "ai_provider_spend_amounts_check" CHECK("ai_provider_spend"."budget_micros" >= 0 AND "ai_provider_spend"."reserved_micros" >= 0 AND "ai_provider_spend"."actual_micros" >= 0),
	CONSTRAINT "ai_provider_spend_source_check" CHECK("ai_provider_spend"."key_source" IN ('platform','user'))
);
--> statement-breakpoint
CREATE TABLE `ai_spend_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_key` text NOT NULL,
	`key_source` text NOT NULL,
	`period_start` text NOT NULL,
	`estimated_micros` integer NOT NULL,
	`actual_micros` integer,
	`settled_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`provider_key`,`key_source`,`period_start`) REFERENCES `ai_provider_spend`(`provider_key`,`key_source`,`period_start`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_spend_reservations_amounts_check" CHECK("ai_spend_reservations"."estimated_micros" >= 0 AND ("ai_spend_reservations"."actual_micros" IS NULL OR "ai_spend_reservations"."actual_micros" >= 0))
);
--> statement-breakpoint
CREATE INDEX `ai_spend_reservations_expiry_idx` ON `ai_spend_reservations` (`settled_at`,`expires_at`);--> statement-breakpoint
CREATE TABLE `analysis_daily_quotas` (
	`user_id` text NOT NULL,
	`period_start` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `period_start`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "analysis_daily_quotas_count_check" CHECK("analysis_daily_quotas"."request_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `core_decisions` (
	`run_id` text NOT NULL,
	`report_version` integer NOT NULL,
	`claim_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`visibility` text NOT NULL,
	`diagnostic_label` text NOT NULL,
	`published_label` text NOT NULL,
	`decision` text NOT NULL,
	PRIMARY KEY(`run_id`, `report_version`, `claim_id`),
	FOREIGN KEY (`run_id`,`report_version`,`tenant_id`,`owner_user_id`,`visibility`) REFERENCES `core_report_versions`(`run_id`,`version`,`tenant_id`,`owner_user_id`,`visibility`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `core_evidence_assessments` (
	`run_id` text NOT NULL,
	`report_version` integer NOT NULL,
	`assessment_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`visibility` text NOT NULL,
	`assessment` text NOT NULL,
	PRIMARY KEY(`run_id`, `report_version`, `assessment_id`),
	FOREIGN KEY (`run_id`,`report_version`,`tenant_id`,`owner_user_id`,`visibility`) REFERENCES `core_report_versions`(`run_id`,`version`,`tenant_id`,`owner_user_id`,`visibility`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `core_assessments_claim_idx` ON `core_evidence_assessments` (`run_id`,`report_version`,`claim_id`);--> statement-breakpoint
CREATE TABLE `analysis_force_cooldowns` (
	`user_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`cooldown_until` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `input_hash`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `analysis_idempotency_keys` (
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`request_status` text NOT NULL,
	`response_body` text,
	`response_blob_uri` text,
	`response_hash` text,
	`response_status` integer,
	`lease_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `endpoint`, `idempotency_key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "analysis_idempotency_storage_check" CHECK(NOT ("analysis_idempotency_keys"."response_body" IS NOT NULL AND "analysis_idempotency_keys"."response_blob_uri" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `analysis_idempotency_expires_idx` ON `analysis_idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `analysis_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`ip_hash` text NOT NULL,
	`endpoint` text NOT NULL,
	`idempotency_key` text,
	`expires_at` integer NOT NULL,
	`released_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `analysis_leases_user_active_idx` ON `analysis_leases` (`user_id`,`released_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `analysis_leases_ip_active_idx` ON `analysis_leases` (`ip_hash`,`released_at`,`expires_at`);--> statement-breakpoint
CREATE TABLE `core_provenance_edges` (
	`run_id` text NOT NULL,
	`report_version` integer NOT NULL,
	`claim_id` text NOT NULL,
	`edge_index` integer NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`visibility` text NOT NULL,
	`from_snapshot_id` text NOT NULL,
	`to_snapshot_id` text NOT NULL,
	`edge` text NOT NULL,
	PRIMARY KEY(`run_id`, `report_version`, `claim_id`, `edge_index`),
	FOREIGN KEY (`run_id`,`report_version`,`tenant_id`,`owner_user_id`,`visibility`) REFERENCES `core_report_versions`(`run_id`,`version`,`tenant_id`,`owner_user_id`,`visibility`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `core_provenance_edges_snapshots_idx` ON `core_provenance_edges` (`run_id`,`from_snapshot_id`,`to_snapshot_id`);--> statement-breakpoint
CREATE TABLE `analysis_rate_limits` (
	`scope_type` text NOT NULL,
	`scope_key` text NOT NULL,
	`window_started_at` integer NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_type`, `scope_key`),
	CONSTRAINT "analysis_rate_limits_count_check" CHECK("analysis_rate_limits"."request_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `core_report_claims` (
	`run_id` text NOT NULL,
	`report_version` integer NOT NULL,
	`claim_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`visibility` text NOT NULL,
	`claim` text NOT NULL,
	PRIMARY KEY(`run_id`, `report_version`, `claim_id`),
	FOREIGN KEY (`run_id`,`report_version`,`tenant_id`,`owner_user_id`,`visibility`) REFERENCES `core_report_versions`(`run_id`,`version`,`tenant_id`,`owner_user_id`,`visibility`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `core_report_snapshots` (
	`run_id` text NOT NULL,
	`report_version` integer NOT NULL,
	`snapshot_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`visibility` text NOT NULL,
	PRIMARY KEY(`run_id`, `report_version`, `snapshot_id`),
	FOREIGN KEY (`run_id`,`report_version`,`tenant_id`,`owner_user_id`,`visibility`) REFERENCES `core_report_versions`(`run_id`,`version`,`tenant_id`,`owner_user_id`,`visibility`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`tenant_id`,`owner_user_id`,`visibility`,`snapshot_id`) REFERENCES `core_snapshots`(`tenant_id`,`owner_user_id`,`visibility`,`snapshot_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `core_report_snapshots_snapshot_idx` ON `core_report_snapshots` (`tenant_id`,`owner_user_id`,`visibility`,`snapshot_id`);--> statement-breakpoint
CREATE TABLE `core_report_versions` (
	`run_id` text NOT NULL,
	`version` integer NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`visibility` text NOT NULL,
	`report_hash` text NOT NULL,
	`schema_version` integer NOT NULL,
	`contract_version` text NOT NULL,
	`engine_version` text NOT NULL,
	`diagnostic_labels` text NOT NULL,
	`published_labels` text NOT NULL,
	`factual_score` real,
	`score_null_reasons` text NOT NULL,
	`evidence_set_hash` text,
	`report` text,
	`report_blob_uri` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `version`),
	FOREIGN KEY (`run_id`,`tenant_id`,`owner_user_id`,`visibility`) REFERENCES `core_runs`(`run_id`,`tenant_id`,`owner_user_id`,`visibility`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "core_report_versions_storage_check" CHECK(("core_report_versions"."report" IS NOT NULL) <> ("core_report_versions"."report_blob_uri" IS NOT NULL)),
	CONSTRAINT "core_report_versions_version_check" CHECK("core_report_versions"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `core_report_versions_hash_idx` ON `core_report_versions` (`run_id`,`report_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `core_report_versions_scope_idx` ON `core_report_versions` (`run_id`,`version`,`tenant_id`,`owner_user_id`,`visibility`);--> statement-breakpoint
CREATE INDEX `core_report_versions_owner_idx` ON `core_report_versions` (`tenant_id`,`owner_user_id`,`visibility`,`run_id`,`version`);--> statement-breakpoint
CREATE TABLE `core_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`visibility` text NOT NULL,
	`input_hash` text NOT NULL,
	`context_hash` text NOT NULL,
	`as_of_time` integer NOT NULL,
	`execution_mode` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text DEFAULT 'normalize_input' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`fencing_token` text,
	`version` integer DEFAULT 0 NOT NULL,
	`versions` text NOT NULL,
	`budget` text NOT NULL,
	`cancellation` text NOT NULL,
	`audit_sink_id` text NOT NULL,
	`provider_source` text,
	`provider` text,
	`input_json` text,
	`input_blob_uri` text,
	`input_payload_hash` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finalized_at` integer,
	CONSTRAINT "core_runs_visibility_check" CHECK("core_runs"."visibility" IN ('private','unlisted','public')),
	CONSTRAINT "core_runs_status_check" CHECK("core_runs"."status" IN ('queued','running','complete','partial','unavailable','failed','canceled')),
	CONSTRAINT "core_runs_attempt_check" CHECK("core_runs"."attempt" >= 0 AND "core_runs"."version" >= 0),
	CONSTRAINT "core_runs_provider_pair_check" CHECK(("core_runs"."provider_source" IS NULL) = ("core_runs"."provider" IS NULL)),
	CONSTRAINT "core_runs_input_storage_check" CHECK(NOT ("core_runs"."input_json" IS NOT NULL AND "core_runs"."input_blob_uri" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `core_runs_scope_idx` ON `core_runs` (`run_id`,`tenant_id`,`owner_user_id`,`visibility`);--> statement-breakpoint
CREATE INDEX `core_runs_owner_created_idx` ON `core_runs` (`tenant_id`,`owner_user_id`,`visibility`,`created_at`);--> statement-breakpoint
CREATE TABLE `core_snapshots` (
	`snapshot_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`visibility` text NOT NULL,
	`content_hash` text NOT NULL,
	`raw_content_hash` text,
	`normalized_text` text,
	`snapshot` text,
	`snapshot_hash` text NOT NULL,
	`snapshot_blob_uri` text,
	`blob_status` text NOT NULL,
	`blob_uri` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `owner_user_id`, `visibility`, `snapshot_id`),
	CONSTRAINT "core_snapshots_visibility_check" CHECK("core_snapshots"."visibility" IN ('private','unlisted','public')),
	CONSTRAINT "core_snapshots_blob_check" CHECK(("core_snapshots"."blob_status" = 'stored' AND "core_snapshots"."blob_uri" IS NOT NULL) OR ("core_snapshots"."blob_status" = 'unavailable' AND "core_snapshots"."blob_uri" IS NULL)),
	CONSTRAINT "core_snapshots_storage_check" CHECK(("core_snapshots"."snapshot" IS NOT NULL) <> ("core_snapshots"."snapshot_blob_uri" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `core_snapshots_content_lookup_idx` ON `core_snapshots` (`tenant_id`,`owner_user_id`,`visibility`,`content_hash`);--> statement-breakpoint
CREATE TABLE `core_stage_attempts` (
	`run_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`visibility` text NOT NULL,
	`stage` text NOT NULL,
	`attempt` integer NOT NULL,
	`fencing_token` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text,
	PRIMARY KEY(`run_id`, `stage`, `attempt`),
	FOREIGN KEY (`run_id`,`tenant_id`,`owner_user_id`,`visibility`) REFERENCES `core_runs`(`run_id`,`tenant_id`,`owner_user_id`,`visibility`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "core_stage_attempts_attempt_check" CHECK("core_stage_attempts"."attempt" > 0)
);
--> statement-breakpoint
CREATE INDEX `core_stage_attempts_owner_idx` ON `core_stage_attempts` (`tenant_id`,`owner_user_id`,`visibility`,`run_id`);--> statement-breakpoint
CREATE TABLE `core_stage_checkpoints` (
	`run_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`visibility` text NOT NULL,
	`stage` text NOT NULL,
	`attempt` integer NOT NULL,
	`fencing_token` text NOT NULL,
	`checkpoint_hash` text NOT NULL,
	`payload_json` text,
	`payload_blob_uri` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `stage`),
	FOREIGN KEY (`run_id`,`tenant_id`,`owner_user_id`,`visibility`) REFERENCES `core_runs`(`run_id`,`tenant_id`,`owner_user_id`,`visibility`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "core_stage_checkpoints_storage_check" CHECK(("core_stage_checkpoints"."payload_json" IS NOT NULL) <> ("core_stage_checkpoints"."payload_blob_uri" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `core_stage_checkpoints_owner_idx` ON `core_stage_checkpoints` (`tenant_id`,`owner_user_id`,`visibility`,`run_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);--> statement-breakpoint
CREATE INDEX `verifications_expires_at_idx` ON `verifications` (`expires_at`);