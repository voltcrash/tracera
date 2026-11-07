CREATE TABLE `core_artifact_candidates` (
	`uri` text PRIMARY KEY NOT NULL,
	`object_version` text NOT NULL,
	`first_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `core_artifact_sweep_state` (
	`id` text PRIMARY KEY NOT NULL,
	`last_key` text
);
