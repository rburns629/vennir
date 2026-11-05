ALTER TABLE "users" ADD COLUMN "self_registered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Accounts that registered themselves before the column, as far as the audit
-- log still records it (each registration's email, once answered 200).
UPDATE "users" SET "self_registered" = true
WHERE lower("email") IN (
  SELECT lower("target"->>'email') FROM "audit_log"
  WHERE "status" = 200 AND "target"->>'email' IS NOT NULL
    AND ("route" = 'vennir.console.v1.AuthService/Register' OR "route" ILIKE '%/auth/register')
);
