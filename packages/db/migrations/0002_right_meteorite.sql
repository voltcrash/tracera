CREATE TABLE `user_provider_keys` (
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
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	PRIMARY KEY(`user_id`, `provider`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_provider_keys_version_check" CHECK("user_provider_keys"."encryption_version" > 0),
	CONSTRAINT "user_provider_keys_fingerprint_check" CHECK(length("user_provider_keys"."fingerprint") = 4),
	CONSTRAINT "user_provider_keys_status_check" CHECK("user_provider_keys"."status" IN ('active','inactive')),
	CONSTRAINT "user_provider_keys_provider_check" CHECK("user_provider_keys"."provider" IN ('anthropic','gemini','openai','openrouter','openai-compatible')),
	CONSTRAINT "user_provider_keys_embedding_provider_check" CHECK("user_provider_keys"."embedding_provider" IS NULL OR "user_provider_keys"."embedding_provider" IN ('gemini','openai','openrouter','openai-compatible'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_provider_keys_active_idx` ON `user_provider_keys` (`user_id`) WHERE "user_provider_keys"."status" = 'active';