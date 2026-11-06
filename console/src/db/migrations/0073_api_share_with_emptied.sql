-- Who else may call an API is each install's grants (decision 26): the
-- teams api.yaml's shareWith named call no more. Emptied, so a gateway from
-- before still running during the upgrade lets none of them in; the column
-- goes in the next release, once nothing reads it.
UPDATE "apis" SET "share_with" = '{}'::text[] WHERE "share_with" <> '{}'::text[];
