ALTER TABLE "users" ADD COLUMN "self_registered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Accounts that registered themselves before the column, as far as the audit
-- log still records it (registrations are audited since the API became
-- Connect's): an email's successful registration with no later deletion or
-- admin-made account of that email, so the account now is the one that
-- registered.
UPDATE "users" AS u SET "self_registered" = true
WHERE EXISTS (
  SELECT 1 FROM "audit_log" AS r
  WHERE r."route" = 'vennir.console.v1.AuthService/Register' AND r."status" = 200
    AND lower(r."target"->>'email') = lower(u."email")
    AND NOT EXISTS (
      SELECT 1 FROM "audit_log" AS later
      WHERE later."at" > r."at" AND later."status" = 200
        AND later."route" IN ('vennir.console.v1.UserService/DeleteUser', 'vennir.console.v1.UserService/CreateUser')
        AND lower(later."target"->>'email') = lower(u."email")
    )
);
