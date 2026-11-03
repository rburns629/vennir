-- A bot belongs to the one team that made it (core/tokens.ts teamBot). A bot
-- already in several teams keeps its earliest membership, its maker's; every
-- token, keyless identity and order callback made since a second team joined
-- is revoked or removed, since it may be that team's, an ordering bot's
-- templates are cleared for its team to list again, and the later
-- memberships go.
UPDATE "api_tokens" t SET "revoked_at" = now()
FROM (
  SELECT m."user_id", (array_agg(m."created_at" ORDER BY m."created_at", m."team_id"))[2] AS "second_joined"
  FROM "team_memberships" m JOIN "users" u ON u."id" = m."user_id"
  WHERE u."is_bot" GROUP BY m."user_id" HAVING count(*) > 1
) s
WHERE t."user_id" = s."user_id" AND t."created_at" >= s."second_joined" AND t."revoked_at" IS NULL;--> statement-breakpoint
DELETE FROM "bot_identities" i
USING (
  SELECT m."user_id", (array_agg(m."created_at" ORDER BY m."created_at", m."team_id"))[2] AS "second_joined"
  FROM "team_memberships" m JOIN "users" u ON u."id" = m."user_id"
  WHERE u."is_bot" GROUP BY m."user_id" HAVING count(*) > 1
) s
WHERE i."bot_id" = s."user_id" AND i."created_at" >= s."second_joined";--> statement-breakpoint
DELETE FROM "bot_callbacks" c
USING (
  SELECT m."user_id", (array_agg(m."created_at" ORDER BY m."created_at", m."team_id"))[2] AS "second_joined"
  FROM "team_memberships" m JOIN "users" u ON u."id" = m."user_id"
  WHERE u."is_bot" GROUP BY m."user_id" HAVING count(*) > 1
) s
WHERE c."bot_id" = s."user_id" AND c."updated_at" >= s."second_joined";--> statement-breakpoint
UPDATE "users" b SET "order_templates" = '{}'::text[]
FROM (
  SELECT m."user_id", (array_agg(m."created_at" ORDER BY m."created_at", m."team_id"))[2] AS "second_joined"
  FROM "team_memberships" m JOIN "users" u ON u."id" = m."user_id"
  WHERE u."is_bot" GROUP BY m."user_id" HAVING count(*) > 1
) s
WHERE b."id" = s."user_id" AND b."order_templates" IS NOT NULL;--> statement-breakpoint
DELETE FROM "team_memberships" m
USING (
  SELECT m2."user_id", m2."team_id",
    row_number() OVER (PARTITION BY m2."user_id" ORDER BY m2."created_at", m2."team_id") AS "n"
  FROM "team_memberships" m2 JOIN "users" u ON u."id" = m2."user_id"
  WHERE u."is_bot"
) r
WHERE m."user_id" = r."user_id" AND m."team_id" = r."team_id" AND r."n" > 1;
