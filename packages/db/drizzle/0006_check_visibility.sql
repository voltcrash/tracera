ALTER TABLE "checks" ADD COLUMN "visibility" varchar(16) NOT NULL DEFAULT 'public';
CREATE INDEX "checks_owner_visibility_idx" ON "checks" ("owner_user_id", "visibility", "created_at");
