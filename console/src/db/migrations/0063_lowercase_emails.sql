-- Accounts' emails are kept lowercase now (db/schema.ts normalEmail). Of
-- the accounts sharing one address in different cases, one keeps it,
-- lowercased: one already lowercase, else the oldest (then the lowest id).
-- Any other is left as typed, so it's no longer found by email, and named
-- in a notice for an admin to settle (two accounts for one address).
DO $$
DECLARE
  skipped record;
BEGIN
  FOR skipped IN
    SELECT u."id", u."email"
    FROM "users" AS u
    WHERE u."email" <> lower(trim(u."email"))
      AND EXISTS (
        SELECT 1 FROM "users" AS other
        WHERE other."id" <> u."id" AND lower(trim(other."email")) = lower(trim(u."email"))
          AND (other."email" = lower(trim(other."email"))
            OR (other."created_at", other."id"::text) < (u."created_at", u."id"::text))
      )
  LOOP
    RAISE NOTICE 'users: % (%) left as typed: another account has the address %', skipped."email", skipped."id", lower(trim(skipped."email"));
  END LOOP;

  UPDATE "users" AS u
  SET "email" = lower(trim(u."email"))
  WHERE u."email" <> lower(trim(u."email"))
    AND NOT EXISTS (
      SELECT 1 FROM "users" AS other
      WHERE other."id" <> u."id" AND lower(trim(other."email")) = lower(trim(u."email"))
        AND (other."email" = lower(trim(other."email"))
          OR (other."created_at", other."id"::text) < (u."created_at", u."id"::text))
    );
END $$;
