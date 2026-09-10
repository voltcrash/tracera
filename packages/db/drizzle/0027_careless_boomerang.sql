CREATE TABLE "core_decisions" (
	"run_id" text NOT NULL,
	"report_version" integer NOT NULL,
	"claim_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) NOT NULL,
	"diagnostic_label" varchar(16) NOT NULL,
	"published_label" varchar(16) NOT NULL,
	"decision" jsonb NOT NULL,
	CONSTRAINT "core_decisions_run_id_report_version_claim_id_pk" PRIMARY KEY("run_id","report_version","claim_id")
);
--> statement-breakpoint
CREATE TABLE "core_evidence_assessments" (
	"run_id" text NOT NULL,
	"report_version" integer NOT NULL,
	"assessment_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) NOT NULL,
	"assessment" jsonb NOT NULL,
	CONSTRAINT "core_evidence_assessments_run_id_report_version_assessment_id_pk" PRIMARY KEY("run_id","report_version","assessment_id")
);
--> statement-breakpoint
CREATE TABLE "core_jobs" (
	"job_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) NOT NULL,
	"stage" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"fencing_token" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancellation_requested" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "core_jobs_status_check" CHECK ("core_jobs"."status" IN ('queued', 'leased', 'retry', 'complete', 'failed', 'canceled')),
	CONSTRAINT "core_jobs_attempt_check" CHECK ("core_jobs"."attempt" >= 0 AND "core_jobs"."max_attempts" > 0),
	CONSTRAINT "core_jobs_lease_state_check" CHECK (("core_jobs"."status" = 'leased') = ("core_jobs"."fencing_token" IS NOT NULL AND "core_jobs"."lease_owner" IS NOT NULL AND "core_jobs"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "core_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) NOT NULL,
	"run_id" text NOT NULL,
	"topic" varchar(64) NOT NULL,
	"deduplication_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "core_provenance_edges" (
	"run_id" text NOT NULL,
	"report_version" integer NOT NULL,
	"claim_id" text NOT NULL,
	"edge_index" integer NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) NOT NULL,
	"from_snapshot_id" text NOT NULL,
	"to_snapshot_id" text NOT NULL,
	"edge" jsonb NOT NULL,
	CONSTRAINT "core_provenance_edges_run_id_report_version_claim_id_edge_index_pk" PRIMARY KEY("run_id","report_version","claim_id","edge_index")
);
--> statement-breakpoint
CREATE TABLE "core_report_claims" (
	"run_id" text NOT NULL,
	"report_version" integer NOT NULL,
	"claim_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) NOT NULL,
	"claim" jsonb NOT NULL,
	CONSTRAINT "core_report_claims_run_id_report_version_claim_id_pk" PRIMARY KEY("run_id","report_version","claim_id")
);
--> statement-breakpoint
CREATE TABLE "core_report_snapshots" (
	"run_id" text NOT NULL,
	"report_version" integer NOT NULL,
	"snapshot_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) NOT NULL,
	CONSTRAINT "core_report_snapshots_run_id_report_version_snapshot_id_pk" PRIMARY KEY("run_id","report_version","snapshot_id")
);
--> statement-breakpoint
CREATE TABLE "core_report_versions" (
	"run_id" text NOT NULL,
	"version" integer NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) NOT NULL,
	"report_hash" varchar(71) NOT NULL,
	"schema_version" integer NOT NULL,
	"contract_version" text NOT NULL,
	"engine_version" text NOT NULL,
	"diagnostic_labels" jsonb NOT NULL,
	"published_labels" jsonb NOT NULL,
	"factual_score" numeric(8, 5),
	"score_null_reasons" jsonb NOT NULL,
	"evidence_set_hash" varchar(71),
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_report_versions_run_id_version_pk" PRIMARY KEY("run_id","version")
);
--> statement-breakpoint
CREATE TABLE "core_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) NOT NULL,
	"input_hash" varchar(71) NOT NULL,
	"as_of_time" timestamp with time zone NOT NULL,
	"execution_mode" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'unavailable' NOT NULL,
	"versions" jsonb NOT NULL,
	"budget" jsonb NOT NULL,
	"cancellation" jsonb NOT NULL,
	"audit_sink_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "core_runs_visibility_check" CHECK ("core_runs"."visibility" IN ('private', 'unlisted', 'public')),
	CONSTRAINT "core_runs_status_check" CHECK ("core_runs"."status" IN ('complete', 'partial', 'unavailable', 'failed', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "core_snapshot_embeddings" (
	"snapshot_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"preprocessing" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_snapshot_embeddings_tenant_id_owner_user_id_visibility_snapshot_id_model_dimensions_preprocessing_pk" PRIMARY KEY("tenant_id","owner_user_id","visibility","snapshot_id","model","dimensions","preprocessing"),
	CONSTRAINT "core_snapshot_embeddings_dimensions_check" CHECK ("core_snapshot_embeddings"."dimensions" = 1024)
);
--> statement-breakpoint
CREATE TABLE "core_snapshots" (
	"snapshot_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) NOT NULL,
	"content_hash" varchar(71) NOT NULL,
	"raw_content_hash" varchar(71),
	"normalized_text" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"blob_status" varchar(16) NOT NULL,
	"blob_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_snapshots_tenant_id_owner_user_id_visibility_snapshot_id_pk" PRIMARY KEY("tenant_id","owner_user_id","visibility","snapshot_id"),
	CONSTRAINT "core_snapshots_visibility_check" CHECK ("core_snapshots"."visibility" IN ('private', 'unlisted', 'public')),
	CONSTRAINT "core_snapshots_blob_check" CHECK (("core_snapshots"."blob_status" = 'stored' AND "core_snapshots"."blob_uri" IS NOT NULL) OR ("core_snapshots"."blob_status" = 'unavailable' AND "core_snapshots"."blob_uri" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "core_stage_attempts" (
	"run_id" text NOT NULL,
	"stage" varchar(32) NOT NULL,
	"attempt" integer NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) NOT NULL,
	"fencing_token" text NOT NULL,
	"worker_id" text NOT NULL,
	"lease_started_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" varchar(16),
	CONSTRAINT "core_stage_attempts_run_id_stage_attempt_pk" PRIMARY KEY("run_id","stage","attempt")
);
--> statement-breakpoint
CREATE TABLE "core_stage_checkpoints" (
	"run_id" text NOT NULL,
	"stage" varchar(32) NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) NOT NULL,
	"attempt" integer NOT NULL,
	"fencing_token" text NOT NULL,
	"checkpoint_hash" varchar(71) NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_stage_checkpoints_run_id_stage_pk" PRIMARY KEY("run_id","stage")
);
--> statement-breakpoint
ALTER TABLE "core_jobs" ADD CONSTRAINT "core_jobs_run_id_core_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."core_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_outbox" ADD CONSTRAINT "core_outbox_run_id_core_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."core_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_report_versions" ADD CONSTRAINT "core_report_versions_run_id_core_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."core_runs"("run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_stage_attempts" ADD CONSTRAINT "core_stage_attempts_run_id_core_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."core_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_stage_checkpoints" ADD CONSTRAINT "core_stage_checkpoints_run_id_core_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."core_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_assessments_claim_idx" ON "core_evidence_assessments" USING btree ("run_id","report_version","claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "core_jobs_run_stage_idx" ON "core_jobs" USING btree ("tenant_id","owner_user_id","visibility","run_id","stage");--> statement-breakpoint
CREATE INDEX "core_jobs_available_idx" ON "core_jobs" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "core_outbox_deduplication_idx" ON "core_outbox" USING btree ("tenant_id","owner_user_id","visibility","deduplication_key");--> statement-breakpoint
CREATE INDEX "core_outbox_pending_idx" ON "core_outbox" USING btree ("published_at","created_at");--> statement-breakpoint
CREATE INDEX "core_provenance_edges_snapshots_idx" ON "core_provenance_edges" USING btree ("run_id","from_snapshot_id","to_snapshot_id");--> statement-breakpoint
CREATE INDEX "core_report_snapshots_snapshot_idx" ON "core_report_snapshots" USING btree ("tenant_id","owner_user_id","visibility","snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "core_report_versions_hash_idx" ON "core_report_versions" USING btree ("run_id","report_hash");--> statement-breakpoint
CREATE INDEX "core_report_versions_owner_idx" ON "core_report_versions" USING btree ("tenant_id","owner_user_id","visibility","run_id","version");--> statement-breakpoint
CREATE INDEX "core_runs_owner_created_idx" ON "core_runs" USING btree ("tenant_id","owner_user_id","visibility","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "core_snapshots_content_identity_idx" ON "core_snapshots" USING btree ("tenant_id","owner_user_id","visibility","content_hash","snapshot_id");--> statement-breakpoint
CREATE INDEX "core_snapshots_content_lookup_idx" ON "core_snapshots" USING btree ("tenant_id","owner_user_id","visibility","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "core_stage_attempts_fence_idx" ON "core_stage_attempts" USING btree ("fencing_token");--> statement-breakpoint
CREATE INDEX "core_stage_attempts_owner_idx" ON "core_stage_attempts" USING btree ("tenant_id","owner_user_id","visibility","run_id");--> statement-breakpoint
CREATE INDEX "core_stage_checkpoints_owner_idx" ON "core_stage_checkpoints" USING btree ("tenant_id","owner_user_id","visibility","run_id");--> statement-breakpoint
