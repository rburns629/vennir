ALTER TABLE "users" ALTER COLUMN "email_kinds" SET DEFAULT '{run_failed,approval_waiting,product_not_ready,catalog_failing,step_refused,platform_alert,api_access}'::text[];--> statement-breakpoint
ALTER TABLE "api_access_requests" ADD COLUMN "offered_groups" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "api_access_requests" ADD COLUMN "offered_groups_read_at" timestamp with time zone;--> statement-breakpoint
-- The new kind is nobody's choice yet: everyone gets it by email, as a new
-- account does; but not someone who turned every email off.
UPDATE "users" SET "email_kinds" = array(SELECT DISTINCT unnest("email_kinds" || '{api_access}'::text[])) WHERE "email_kinds" <> '{}'::text[];--> statement-breakpoint
-- A request shows only the groups its person offers (offered_groups): the
-- copies of everyone's groups that requests took before are emptied, never
-- shown. (A console from before still writes them while it runs.)
UPDATE "api_access_requests" SET "requester_groups" = '{}'::text[], "requester_groups_read_at" = NULL WHERE "requester_groups" <> '{}'::text[] OR "requester_groups_read_at" IS NOT NULL;
