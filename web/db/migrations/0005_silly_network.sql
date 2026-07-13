ALTER TABLE "spools" ADD COLUMN "repo_owner" text;--> statement-breakpoint
ALTER TABLE "spools" ADD COLUMN "repo_name" text;--> statement-breakpoint
ALTER TABLE "spools" ADD COLUMN "pr_number" integer;--> statement-breakpoint
CREATE INDEX "spools_project_idx" ON "spools" USING btree ("owner_id","repo_owner","repo_name");