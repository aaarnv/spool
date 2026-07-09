CREATE TABLE "vo_usage" (
	"owner_id" text NOT NULL,
	"day" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "vo_usage_owner_id_day_pk" PRIMARY KEY("owner_id","day")
);
