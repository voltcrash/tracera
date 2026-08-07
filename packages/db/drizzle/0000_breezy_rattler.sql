CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"input_type" varchar(32) NOT NULL,
	"raw_input" text NOT NULL,
	"source_domain" text,
	"tracera_score" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"claim_text" text NOT NULL,
	"claim_type" varchar(64) NOT NULL,
	"checkability" varchar(32) NOT NULL,
	"verdict" varchar(32),
	"confidence" numeric(5, 4),
	"reasoning" text,
	"evidence_quality" numeric(5, 4),
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"domain" text PRIMARY KEY NOT NULL,
	"trust_score" numeric(5, 4) NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;
