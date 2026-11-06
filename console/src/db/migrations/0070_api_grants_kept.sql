-- Grants and requests outlive their API leaving the catalog's release: keyed
-- by its team and name too, the API set null when its row goes, and linked
-- again when it's back (queries.ts upsertApi). Rows from 0069 are backfilled
-- from their API before the columns are required.
ALTER TABLE "api_access_requests" DROP CONSTRAINT "api_access_requests_api_id_apis_id_fk";
--> statement-breakpoint
ALTER TABLE "api_grants" DROP CONSTRAINT "api_grants_api_id_apis_id_fk";
--> statement-breakpoint
ALTER TABLE "api_access_requests" ALTER COLUMN "api_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_grants" ALTER COLUMN "api_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_access_requests" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "api_access_requests" ADD COLUMN "api_name" text;--> statement-breakpoint
ALTER TABLE "api_access_requests" ADD COLUMN "requester_groups" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "api_grants" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "api_grants" ADD COLUMN "api_name" text;--> statement-breakpoint
UPDATE "api_access_requests" r SET "team_id" = a."team_id", "api_name" = a."name" FROM "apis" a WHERE a."id" = r."api_id";--> statement-breakpoint
UPDATE "api_grants" g SET "team_id" = a."team_id", "api_name" = a."name" FROM "apis" a WHERE a."id" = g."api_id";--> statement-breakpoint
ALTER TABLE "api_access_requests" ALTER COLUMN "team_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_access_requests" ALTER COLUMN "api_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_grants" ALTER COLUMN "team_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_grants" ALTER COLUMN "api_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sso_groups" text[];--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sso_groups_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_access_requests" ADD CONSTRAINT "api_access_requests_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_access_requests" ADD CONSTRAINT "api_access_requests_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_grants" ADD CONSTRAINT "api_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_grants" ADD CONSTRAINT "api_grants_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- user_groups keeps only the groups that matter from now on; the next
-- sign-in or resync writes them again.
DELETE FROM "user_groups";
