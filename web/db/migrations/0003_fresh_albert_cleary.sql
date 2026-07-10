ALTER TABLE "edit_jobs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "edit_jobs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "edit_jobs_one_active_per_spool" ON "edit_jobs" USING btree ("spool_id") WHERE status in ('queued', 'running');