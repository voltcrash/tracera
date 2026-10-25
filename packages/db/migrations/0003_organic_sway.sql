ALTER TABLE `core_report_versions` ADD `summary_headline` text;--> statement-breakpoint
UPDATE core_report_versions
SET summary_headline = COALESCE(
  (SELECT json_extract(value, '$.text') FROM json_each(core_report_versions.report, '$.claims')
   WHERE json_extract(value, '$.duplicateOfClaimId') IS NULL
     AND json_extract(value, '$.coverageDisposition') != 'deferred'
   ORDER BY CAST(key AS INTEGER) LIMIT 1),
  (SELECT json_extract(value, '$.text') FROM json_each(core_report_versions.report, '$.claims')
   WHERE json_extract(value, '$.duplicateOfClaimId') IS NULL
   ORDER BY CAST(key AS INTEGER) LIMIT 1),
  'Focused analysis'
)
WHERE report IS NOT NULL;
