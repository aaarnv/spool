CREATE TABLE "ask_usage" (
	"spool_id" text NOT NULL,
	"ip_hash" text NOT NULL,
	"day" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ask_usage_spool_id_ip_hash_day_pk" PRIMARY KEY("spool_id","ip_hash","day")
);
