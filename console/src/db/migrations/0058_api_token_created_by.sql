ALTER TABLE "api_tokens" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Who made each team bot's token so far, from its audit entry: the
-- CreateBotToken call for that bot's address and label, just after it.
UPDATE "api_tokens" t SET "created_by" = m."actor_id"
FROM (
  SELECT DISTINCT ON (t2."id") t2."id", a."actor_id"
  FROM "api_tokens" t2
  JOIN "users" u ON u."id" = t2."user_id" AND u."is_bot"
  JOIN "audit_log" a ON a."route" = 'vertra.console.v1.TokenService/CreateBotToken' AND a."status" = 200
    AND a."target"->>'email' = u."email" AND a."target"->>'label' = t2."label"
    AND a."at" BETWEEN t2."created_at" AND t2."created_at" + interval '1 minute'
  JOIN "users" maker ON maker."id" = a."actor_id"
  ORDER BY t2."id", a."at"
) m
WHERE t."id" = m."id" AND t."created_by" IS NULL;
