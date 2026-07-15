CREATE TABLE "billing" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"stripe_customer_id" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"current_period_end" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
