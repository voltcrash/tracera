ALTER TABLE "users" ADD COLUMN "clerk_user_id" text;
ALTER TABLE "users" ADD CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id");

-- Clerk now owns credentials, verification, password recovery, and sessions.
DROP TABLE IF EXISTS "account_tokens";
DROP TABLE IF EXISTS "auth_sessions";
ALTER TABLE "users" DROP COLUMN "password_hash";
ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verified_at";
