CREATE TABLE "analysis_rate_limits" (
  "scope_type" varchar(8) NOT NULL,
  "scope_key" text NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL,
  "request_count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "analysis_rate_limits_pkey" PRIMARY KEY ("scope_type", "scope_key")
);

CREATE TABLE "analysis_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "ip_hash" text NOT NULL,
  "endpoint" varchar(64) NOT NULL,
  "idempotency_key" varchar(255),
  "expires_at" timestamp with time zone NOT NULL,
  "released_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "analysis_leases_user_active_idx"
  ON "analysis_leases" ("user_id", "released_at", "expires_at");
CREATE INDEX "analysis_leases_ip_active_idx"
  ON "analysis_leases" ("ip_hash", "released_at", "expires_at");

CREATE TABLE "analysis_idempotency_keys" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "endpoint" varchar(64) NOT NULL,
  "idempotency_key" varchar(255) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "request_status" varchar(16) NOT NULL,
  "response_body" jsonb,
  "response_status" integer,
  "lease_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "analysis_idempotency_keys_pkey"
    PRIMARY KEY ("user_id", "endpoint", "idempotency_key")
);

CREATE INDEX "analysis_idempotency_expires_idx"
  ON "analysis_idempotency_keys" ("expires_at");

CREATE TABLE "analysis_daily_quotas" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "period_start" date NOT NULL,
  "request_count" integer NOT NULL DEFAULT 0,
  CONSTRAINT "analysis_daily_quotas_pkey" PRIMARY KEY ("user_id", "period_start")
);

CREATE TABLE "analysis_force_cooldowns" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "input_hash" varchar(64) NOT NULL,
  "cooldown_until" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "analysis_force_cooldowns_pkey" PRIMARY KEY ("user_id", "input_hash")
);

CREATE TABLE "ai_provider_spend" (
  "provider_key" varchar(128) NOT NULL,
  "period_start" date NOT NULL,
  "budget_usd" numeric(12, 6) NOT NULL,
  "reserved_usd" numeric(12, 6) NOT NULL DEFAULT 0,
  "actual_usd" numeric(12, 6) NOT NULL DEFAULT 0,
  "open_until" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ai_provider_spend_pkey" PRIMARY KEY ("provider_key", "period_start")
);

CREATE TABLE "ai_spend_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_key" varchar(128) NOT NULL,
  "period_start" date NOT NULL,
  "estimated_usd" numeric(12, 6) NOT NULL,
  "actual_usd" numeric(12, 6),
  "settled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "ai_spend_reservations_pending_idx"
  ON "ai_spend_reservations" ("provider_key", "period_start", "settled_at");
