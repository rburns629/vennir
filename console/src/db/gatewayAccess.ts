// SPDX-License-Identifier: MIT
/**
 * The gateway's own database role: what it reads to sign callers in and
 * find the published APIs, and its traffic counts, what it can't serve and
 * when an API token was last used, and nothing else. Never
 * a password hash, a sealed value or a secret's name: column grants on
 * `users` and `teams`, and no grant at all on the rest. Run by the
 * migration Job (migrate.ts) after the migrations, as the tables' owner, so
 * a column the gateway starts to read is granted here in the same change
 * (gateway/internal/auth and store, kept in step).
 *
 * The role itself is made by whoever made the database: the kernel chart's
 * hook on its shared Postgres (postgres.consoleDatabase), or this, when the
 * console runs as its own Postgres's superuser and is given a password.
 */
import type { Pool, PoolClient } from "pg";

const GRANTS = [
  "GRANT SELECT (id, email, is_admin, is_bot, password_changed_at, must_change_password, order_templates) ON users TO %I",
  "GRANT SELECT (id, user_id, token_hash, revoked_at, expires_at, last_used_at) ON api_tokens TO %I",
  // A token used at the gateway is used: its last_used_at, and nothing else of it.
  "GRANT UPDATE (last_used_at) ON api_tokens TO %I",
  // from_groups, never via_groups: whether groups gave a membership, not which.
  "REVOKE SELECT (via_groups) ON team_memberships FROM %I",
  "GRANT SELECT (user_id, team_id, from_groups) ON team_memberships TO %I",
  // Which teams follow single sign-on groups: their ids, nothing of the groups.
  "GRANT SELECT (team_id) ON sso_group_mappings TO %I",
  "GRANT SELECT (id, name, require_sso, retired_at, deleted_at) ON teams TO %I",
  "GRANT SELECT ON apis, gateway_state, revoked_sessions TO %I",
  // Who else may call each API (decision 26): the active grants' principals
  // and rates, never who granted or why; and each person's groups, for a
  // group's grant. Nothing of the requests for access.
  "GRANT SELECT (id, api_id, group_name, user_id, per_minute, revoked_at) ON api_grants TO %I",
  "GRANT SELECT (user_id, group_name) ON user_groups TO %I",
  // Whether an admin turned single sign-on on, and whether groups come from
  // a claim: never its client secret.
  "GRANT SELECT (id, enabled, issuer, client_id, redirect_url, groups_claim) ON sso_settings TO %I",
  "GRANT SELECT, INSERT, UPDATE ON api_traffic TO %I",
  "GRANT SELECT, INSERT, UPDATE, DELETE ON api_problems TO %I",
];

/** Grants the gateway's role what it reads and writes; creates it first, with
 * `password`, when it isn't there. Throws when it can't, so a gateway
 * that couldn't sign in is found at deploy time, not at its first request. */
export async function ensureGatewayAccess(pool: Pool, role: string, password: string | undefined): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ exists: boolean }>("SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = $1) AS exists", [role]);
    if (!rows[0]?.exists) {
      if (!password) throw new Error(`The gateway's database role "${role}" doesn't exist, and no password was given to create it.`);
      await client.query(await formatted(client, "CREATE ROLE %I LOGIN PASSWORD %L", role, password));
    } else if (password) {
      await client.query(await formatted(client, "ALTER ROLE %I WITH LOGIN PASSWORD %L", role, password));
    }
    await client.query(await formatted(client, "GRANT CONNECT ON DATABASE %I TO %I", await currentDatabase(client), role));
    await client.query(await formatted(client, "GRANT USAGE ON SCHEMA public TO %I", role));
    for (const grant of GRANTS) await client.query(await formatted(client, grant, role));
  } finally {
    client.release();
  }
}

/** Postgres's own format(), so names and the password are quoted by the server. */
async function formatted(client: PoolClient, template: string, ...args: string[]): Promise<string> {
  const placeholders = args.map((_, i) => `$${String(i + 2)}::text`).join(", ");
  const { rows } = await client.query<{ sql: string }>(`SELECT format($1, ${placeholders}) AS sql`, [template, ...args]);
  return rows[0]?.sql ?? "";
}

async function currentDatabase(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ db: string }>("SELECT current_database() AS db");
  return rows[0]?.db ?? "";
}
