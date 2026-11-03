CREATE TABLE "chat_limits" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"per_hour" integer NOT NULL,
	"per_day" integer NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_limits_one_row" CHECK ("chat_limits"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "chat_limits" ADD CONSTRAINT "chat_limits_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;