ALTER TABLE "api_access_requests" ADD COLUMN "requester_groups_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_access_requests" ADD COLUMN "away_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_grants" ADD COLUMN "revoke_reason" text;--> statement-breakpoint
ALTER TABLE "api_grants" ADD COLUMN "away_since" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "api_access_requests_team_api_idx" ON "api_access_requests" USING btree ("team_id","api_name");--> statement-breakpoint
CREATE INDEX "api_grants_team_api_idx" ON "api_grants" USING btree ("team_id","api_name");--> statement-breakpoint
-- Rows already away (from 0070) count from now: 30 days to come back.
UPDATE "api_grants" SET "away_since" = now() WHERE "api_id" IS NULL;--> statement-breakpoint
UPDATE "api_access_requests" SET "away_since" = now() WHERE "api_id" IS NULL;
