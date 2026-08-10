DROP TABLE IF EXISTS "account_tokens";
DROP TABLE IF EXISTS "auth_sessions";
DROP TABLE IF EXISTS "users" CASCADE;

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "email_verified" boolean DEFAULT false NOT NULL,
  "image" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

UPDATE "checks" SET "owner_user_id" = NULL;
UPDATE "domain_trust_events" SET "reviewer_user_id" = NULL;
TRUNCATE TABLE "media_diet_preferences";
ALTER TABLE "checks" ADD CONSTRAINT "checks_owner_user_id_users_id_fk"
  FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "domain_trust_events" ADD CONSTRAINT "domain_trust_events_reviewer_user_id_users_id_fk"
  FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "media_diet_preferences" ADD CONSTRAINT "media_diet_preferences_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

CREATE TABLE "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "sessions_token_idx" ON "sessions" ("token");
CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");
CREATE INDEX "sessions_expires_at_idx" ON "sessions" ("expires_at");

CREATE TABLE "accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "access_token_expires_at" timestamp with time zone,
  "refresh_token_expires_at" timestamp with time zone,
  "scope" text,
  "id_token" text,
  "password" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "accounts_provider_account_idx"
  ON "accounts" ("provider_id", "account_id");
CREATE INDEX "accounts_user_id_idx" ON "accounts" ("user_id");

CREATE TABLE "verifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "verifications_identifier_idx" ON "verifications" ("identifier");
