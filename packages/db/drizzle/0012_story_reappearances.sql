ALTER TABLE "checks"
  ADD COLUMN "lineage_reason" varchar(32) NOT NULL DEFAULT 'first_check';

CREATE TABLE "trace_appearances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "check_id" uuid NOT NULL REFERENCES "checks"("id") ON DELETE CASCADE,
  "source_url" text,
  "source_domain" text,
  "occurrence_type" varchar(32) NOT NULL,
  "observed_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "trace_appearances_check_time_idx"
  ON "trace_appearances" ("check_id", "observed_at");
