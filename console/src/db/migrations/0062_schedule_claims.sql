ALTER TABLE "schedules" ADD COLUMN "claimed_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "claimed_at" timestamp with time zone;