CREATE TABLE "bundle_misses" (
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"day" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"asks" integer DEFAULT 0 NOT NULL,
	"owner_id" text NOT NULL,
	"last_spool_id" text,
	"last_pr_number" integer,
	"paths" jsonb,
	CONSTRAINT "bundle_misses_repo_owner_repo_name_day_pk" PRIMARY KEY("repo_owner","repo_name","day")
);
