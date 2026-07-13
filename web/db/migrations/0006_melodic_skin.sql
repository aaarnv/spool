CREATE TABLE "project_knowledge" (
	"owner_id" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"store" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_knowledge_owner_id_repo_owner_repo_name_pk" PRIMARY KEY("owner_id","repo_owner","repo_name")
);
