-- Accounts' emails are kept lowercase now (db/queries.ts normalEmail):
-- one registered as typed (Alice@x.com) is lowercased, unless another
-- account has the same email in another case. Those are two accounts for
-- one address, left as they are: only one already lowercase can still be
-- found by email, and an admin removes the other in the database.
UPDATE "users" AS u
SET "email" = lower(trim(u."email"))
WHERE u."email" <> lower(trim(u."email"))
  AND NOT EXISTS (
    SELECT 1 FROM "users" AS other
    WHERE other."id" <> u."id" AND lower(trim(other."email")) = lower(trim(u."email"))
  );
