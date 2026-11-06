ALTER TABLE `core_runs` ADD `usage_targeted_rounds` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Earlier attempts may have spent rounds without reaching a checkpoint.
UPDATE core_runs SET usage_targeted_rounds=json_extract(budget,'$.maxTargetedRetrievalRounds')
WHERE attempt>0 AND finalized_at IS NULL;
