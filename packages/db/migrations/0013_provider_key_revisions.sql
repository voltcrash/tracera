PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_user_provider_keys` (
	`id` text PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`base_url` text,
	`model` text NOT NULL,
	`embedding_provider` text,
	`embedding_base_url` text,
	`embedding_model` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`encryption_version` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`health` text DEFAULT 'verified' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_provider_keys_version_check" CHECK("__new_user_provider_keys"."encryption_version" > 0),
	CONSTRAINT "user_provider_keys_fingerprint_check" CHECK(length("__new_user_provider_keys"."fingerprint") = 4),
	CONSTRAINT "user_provider_keys_status_check" CHECK("__new_user_provider_keys"."status" IN ('active','inactive')),
	CONSTRAINT "user_provider_keys_current_check" CHECK("__new_user_provider_keys"."is_current" IN (0,1) AND ("__new_user_provider_keys"."status"<>'active' OR "__new_user_provider_keys"."is_current"=1)),
	CONSTRAINT "user_provider_keys_health_check" CHECK("__new_user_provider_keys"."health" IN ('verified','rejected')),
	CONSTRAINT "user_provider_keys_provider_check" CHECK("__new_user_provider_keys"."provider" IN ('anthropic','gemini','openai','openrouter','openai-compatible')),
	CONSTRAINT "user_provider_keys_embedding_provider_check" CHECK("__new_user_provider_keys"."embedding_provider" IS NULL OR "__new_user_provider_keys"."embedding_provider" IN ('gemini','openai','openrouter','openai-compatible'))
);
--> statement-breakpoint
INSERT INTO `__new_user_provider_keys`("user_id", "provider", "base_url", "model", "embedding_provider", "embedding_base_url", "embedding_model", "ciphertext", "iv", "encryption_version", "fingerprint", "status", "created_at", "last_used_at") SELECT "user_id", "provider", "base_url", "model", "embedding_provider", "embedding_base_url", "embedding_model", "ciphertext", "iv", "encryption_version", "fingerprint", "status", "created_at", "last_used_at" FROM `user_provider_keys`;--> statement-breakpoint
DROP TABLE `user_provider_keys`;--> statement-breakpoint
ALTER TABLE `__new_user_provider_keys` RENAME TO `user_provider_keys`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE UNIQUE INDEX `user_provider_keys_current_idx` ON `user_provider_keys` (`user_id`,`provider`) WHERE "user_provider_keys"."is_current"=1;--> statement-breakpoint
CREATE UNIQUE INDEX `user_provider_keys_active_idx` ON `user_provider_keys` (`user_id`) WHERE "user_provider_keys"."status" = 'active';--> statement-breakpoint
ALTER TABLE `core_runs` ADD `provider_key_revision_id` text;
--> statement-breakpoint
CREATE TRIGGER user_provider_keys_revision_guard BEFORE UPDATE ON user_provider_keys
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.provider IS NOT OLD.provider
  OR NEW.base_url IS NOT OLD.base_url OR NEW.model IS NOT OLD.model
  OR NEW.embedding_provider IS NOT OLD.embedding_provider OR NEW.embedding_base_url IS NOT OLD.embedding_base_url
  OR NEW.embedding_model IS NOT OLD.embedding_model OR NEW.ciphertext IS NOT OLD.ciphertext
  OR NEW.iv IS NOT OLD.iv OR NEW.encryption_version IS NOT OLD.encryption_version
  OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.created_at IS NOT OLD.created_at
  OR NEW.is_current>OLD.is_current OR (OLD.health='rejected' AND NEW.health<>OLD.health)
BEGIN SELECT RAISE(ABORT, 'Provider key revisions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER core_runs_provider_revision_guard BEFORE INSERT ON core_runs
WHEN NOT EXISTS(SELECT 1 FROM core_runs WHERE run_id=NEW.run_id) AND (
  (NEW.provider_source='user' AND (NEW.provider_key_revision_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM user_provider_keys WHERE id=NEW.provider_key_revision_id AND user_id=NEW.owner_user_id
    AND provider=NEW.provider AND health='verified' AND model=json_extract(NEW.versions,'$.model')
    AND embedding_model=json_extract(NEW.versions,'$.embedding.model'))))
  OR (NEW.provider_key_revision_id IS NOT NULL AND NEW.provider_source IS NOT 'user'))
BEGIN SELECT RAISE(ABORT, 'Personal runs require an available owned key revision'); END;
--> statement-breakpoint
CREATE TRIGGER core_runs_provider_revision_immutable BEFORE UPDATE ON core_runs
WHEN NEW.provider_key_revision_id IS NOT OLD.provider_key_revision_id
  OR NEW.provider_source IS NOT OLD.provider_source OR NEW.provider IS NOT OLD.provider
BEGIN SELECT RAISE(ABORT, 'Run provider identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER core_runs_provider_usage_guard BEFORE UPDATE ON core_runs
WHEN NEW.provider_source='user'
  AND (NEW.usage_external_requests>OLD.usage_external_requests OR NEW.usage_cost_micros>OLD.usage_cost_micros)
  AND NOT EXISTS(SELECT 1 FROM user_provider_keys WHERE id=NEW.provider_key_revision_id
    AND user_id=NEW.owner_user_id AND provider=NEW.provider AND health='verified')
BEGIN SELECT RAISE(ABORT, 'Provider revision is unavailable for request admission'); END;
