CREATE TABLE "decay_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "check_id" uuid REFERENCES "checks"("id") ON DELETE SET NULL,
  "event_type" varchar(48) NOT NULL,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "decay_events_created_at_idx" ON "decay_events" ("created_at" DESC);
CREATE INDEX "decay_events_check_id_idx" ON "decay_events" ("check_id", "created_at" DESC);
