-- A single sign-on member of a mapped team follows their groups (sso.ts
-- syncMappedTeams keeps or removes the membership at their next sign-in,
-- whatever via_groups says), but memberships from before 0055 have no
-- via_groups: mark them, so they count as group-given (auth/plugin.ts).
UPDATE "team_memberships" SET "via_groups" = '{}'
WHERE "via_groups" IS NULL
  AND "team_id" IN (SELECT "team_id" FROM "sso_group_mappings")
  AND "user_id" IN (SELECT "id" FROM "users" WHERE "oidc_subject" IS NOT NULL AND NOT "is_bot");--> statement-breakpoint
ALTER TABLE "team_memberships" ADD COLUMN "from_groups" boolean GENERATED ALWAYS AS (via_groups is not null) STORED NOT NULL;
