CREATE TABLE "domain_trust_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "domain" text NOT NULL REFERENCES "domains"("domain") ON DELETE CASCADE,
  "check_id" uuid REFERENCES "checks"("id") ON DELETE SET NULL,
  "reviewer_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "signal_type" varchar(32) NOT NULL,
  "previous_score" numeric(5,4) NOT NULL,
  "proposed_score" numeric(5,4) NOT NULL,
  "applied_score" numeric(5,4),
  "detail" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "domain_trust_events_domain_time_idx"
  ON "domain_trust_events" ("domain", "created_at");
