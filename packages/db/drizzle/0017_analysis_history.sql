-- Records every analysis a signed-in user runs, including the ones served from
-- a recent identical trace. Ownership alone cannot answer "what have I checked?"
-- because a reused trace keeps the original submitter as its owner.
CREATE TABLE "analysis_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "check_id" uuid NOT NULL REFERENCES "checks"("id") ON DELETE CASCADE,
  "analyzed_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "analysis_history_user_time_idx"
  ON "analysis_history" ("user_id", "analyzed_at" DESC);

CREATE INDEX "analysis_history_user_check_idx"
  ON "analysis_history" ("user_id", "check_id");

-- Traces analyzed before this table existed are attributed to their owner so an
-- existing account opens History with its record intact.
INSERT INTO "analysis_history" ("user_id", "check_id", "analyzed_at")
SELECT "owner_user_id", "id", "created_at"
  FROM "checks"
 WHERE "owner_user_id" IS NOT NULL;
