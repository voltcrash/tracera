ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;
CREATE TABLE "account_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "kind" varchar(24) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "account_tokens_user_kind_idx" ON "account_tokens" ("user_id", "kind");
