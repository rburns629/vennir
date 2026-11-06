-- SPDX-License-Identifier: MIT
-- What `kernel policy` (internal/policy) applied from the catalog's
-- verified releases, which it writes into the cluster's catalog policies
-- (decision 27, docs/assessment.md).

-- The release applied: one row, once one has been.
CREATE TABLE catalog_policy_state (
    id smallint NOT NULL PRIMARY KEY CHECK (id = 1),
    release_reference text NOT NULL,
    release_digest text NOT NULL,
    released_at timestamptz NOT NULL,
    commit text NOT NULL DEFAULT '',
    -- Which signers verified it (Signers.Fingerprint): when the kernel
    -- chart trusts others, it's verified again before it's trusted.
    signers text NOT NULL DEFAULT '',
    applied_at timestamptz NOT NULL DEFAULT now(),
    apis jsonb NOT NULL DEFAULT '[]'
);

-- Each product release a verified release named: its digest and the
-- product it's a release of, as the identity policy matches a step.
-- released_until is when a later release stopped naming it (NULL while the
-- applied one does); it stays listed for an hour after, or while an
-- unfinished task runs it.
CREATE TABLE catalog_policy_releases (
    digest text NOT NULL,
    team text NOT NULL,
    repository text NOT NULL,
    action text NOT NULL,
    service_account text NOT NULL,
    audiences text NOT NULL,
    -- The signers its release was verified by (as catalog_policy_state's):
    -- when the chart trusts others, an earlier release only they signed goes.
    signers text NOT NULL DEFAULT '',
    released_until timestamptz,
    PRIMARY KEY (digest, team, repository, action, service_account, audiences)
);
