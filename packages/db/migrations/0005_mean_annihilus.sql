ALTER TABLE `core_runs` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `core_runs` ADD `usage_external_requests` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `core_runs` ADD `usage_cost_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `core_runs` SET `started_at`=`created_at`,
  `usage_external_requests`=json_extract(`budget`,'$.maxExternalRequests'),
  `usage_cost_micros`=COALESCE(ROUND(json_extract(`budget`,'$.maxCostUsd')*1000000),0)
WHERE `attempt`>0 AND `finalized_at` IS NULL;
