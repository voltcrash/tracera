ALTER TABLE `ai_provider_spend` ADD `estimated_settled_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_provider_spend` ADD `measured_settled_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_spend_reservations` ADD `settlement_basis` text;
--> statement-breakpoint
UPDATE ai_spend_reservations SET settlement_basis='legacy_unknown' WHERE settled_at IS NOT NULL;
