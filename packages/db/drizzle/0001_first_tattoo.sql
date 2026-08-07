ALTER TABLE "checks" ADD COLUMN "embedding" vector(1024) NOT NULL;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "analysis" jsonb NOT NULL;