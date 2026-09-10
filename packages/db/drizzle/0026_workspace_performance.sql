CREATE INDEX IF NOT EXISTS "checks_owner_created_idx"
  ON "checks" USING btree ("owner_user_id", "created_at");

CREATE INDEX IF NOT EXISTS "checks_visibility_created_idx"
  ON "checks" USING btree ("visibility", "created_at");

CREATE INDEX IF NOT EXISTS "checks_supersedes_idx"
  ON "checks" USING btree ("supersedes_check_id");

CREATE INDEX IF NOT EXISTS "trace_appearances_check_observed_idx"
  ON "trace_appearances" USING btree ("check_id", "observed_at");
