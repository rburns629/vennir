ALTER TABLE "users" ALTER COLUMN "email_kinds" SET DEFAULT '{run_failed,approval_waiting,product_not_ready,catalog_failing,step_refused,platform_alert,api_access}'::text[];--> statement-breakpoint
-- The new kind is nobody's choice yet: everyone gets it by email, as a new account does.
UPDATE "users" SET "email_kinds" = array(SELECT DISTINCT unnest("email_kinds" || '{api_access}'::text[]));--> statement-breakpoint
-- A request keeps only the groups its person offers now: the copies of
-- everyone's groups that requests took before are emptied, never shown.
UPDATE "api_access_requests" SET "requester_groups" = '{}'::text[], "requester_groups_read_at" = NULL WHERE "requester_groups" <> '{}'::text[] OR "requester_groups_read_at" IS NOT NULL;
