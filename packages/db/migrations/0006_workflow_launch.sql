ALTER TABLE `core_runs` ADD `launch_status` text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE `core_runs` ADD `launch_attempted_at` integer;--> statement-breakpoint
ALTER TABLE `core_runs` ADD `launch_admission` text;--> statement-breakpoint
UPDATE `core_runs` SET `launch_status`='unknown',`launch_attempted_at`=`created_at`,
  `launch_admission`=CASE WHEN `input_json` IS NOT NULL THEN json_extract(`input_json`,'$.admission') ELSE NULL END
WHERE `status`='queued' AND `finalized_at` IS NULL;
