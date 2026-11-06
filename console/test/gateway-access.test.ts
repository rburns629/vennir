// SPDX-License-Identifier: MIT
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ensureGatewayAccess } from "../src/db/gatewayAccess.js";

// Against the real test database, as its superuser: the role is made, then
// used, as the gateway would use it.
const url = process.env["DATABASE_URL"] ?? "";
const owner = new pg.Pool({ connectionString: url });
const ROLE = "vennir_gateway_test";
const PASSWORD = "gateway-test-only";

afterAll(async () => {
  await owner.end();
});

function asGateway(): pg.Client {
  const target = new URL(url);
  target.username = ROLE;
  target.password = PASSWORD;
  return new pg.Client({ connectionString: target.toString() });
}

describe("the gateway's database role", () => {
  it("is made when missing, and can read what the gateway reads and nothing more", async () => {
    await owner.query(`DROP OWNED BY ${ROLE}`).catch(() => undefined);
    await owner.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await ensureGatewayAccess(owner, ROLE, PASSWORD);
    // Again: idempotent, and without a password it keeps the role as it is.
    await ensureGatewayAccess(owner, ROLE, undefined);

    const gateway = asGateway();
    await gateway.connect();
    try {
      // What the gateway's own queries read (gateway/internal/auth, store).
      await gateway.query("SELECT id, email, is_admin, is_bot, password_changed_at, must_change_password, order_templates IS NOT NULL FROM users LIMIT 1");
      await gateway.query("SELECT EXISTS (SELECT 1 FROM sso_settings WHERE id = 1 AND enabled AND issuer <> '' AND client_id <> '' AND redirect_url <> '')");
      await gateway.query("SELECT id, user_id, token_hash, revoked_at, expires_at, last_used_at FROM api_tokens LIMIT 1");
      await gateway.query("UPDATE api_tokens SET last_used_at = now() WHERE id = gen_random_uuid()");
      await gateway.query(
        "SELECT t.name, t.require_sso, m.from_groups AND EXISTS (SELECT 1 FROM sso_group_mappings g WHERE g.team_id = t.id) FROM team_memberships m JOIN teams t ON t.id = m.team_id LIMIT 1",
      );
      await gateway.query("SELECT EXISTS (SELECT 1 FROM sso_settings WHERE id = 1 AND groups_claim <> '')");
      await gateway.query("SELECT a.id FROM apis a JOIN teams t ON t.id = a.team_id WHERE t.retired_at IS NULL AND t.deleted_at IS NULL LIMIT 1");
      await gateway.query("SELECT sid FROM revoked_sessions LIMIT 1");
      await gateway.query("SELECT closed_message FROM gateway_state LIMIT 1");
      // The active grants (gateway/internal/store), and a caller's groups (auth).
      await gateway.query(
        "SELECT g.id::text, g.api_id::text, coalesce(g.group_name, ''), coalesce(g.user_id::text, ''), coalesce(g.per_minute, 0) FROM api_grants g WHERE g.revoked_at IS NULL LIMIT 1",
      );
      await gateway.query("SELECT ARRAY(SELECT group_name FROM user_groups WHERE user_id = gen_random_uuid())");
      await gateway.query("SELECT access_requests FROM apis LIMIT 1");
      const { rows } = await gateway.query<{ write: boolean }>("SELECT has_table_privilege('api_traffic', 'INSERT, UPDATE') AS write");
      expect(rows[0]?.write).toBe(true);
      // And never what it doesn't.
      for (const refused of [
        "SELECT password_hash FROM users LIMIT 1",
        "SELECT label FROM api_tokens LIMIT 1",
        "SELECT * FROM secret_grants LIMIT 1",
        "SELECT * FROM audit_log LIMIT 1",
        "SELECT * FROM audit_reads LIMIT 1",
        "SELECT * FROM sso_settings LIMIT 1",
        "SELECT client_secret_encrypted FROM sso_settings LIMIT 1",
        "SELECT group_name FROM sso_group_mappings LIMIT 1",
        "SELECT via_groups FROM team_memberships LIMIT 1",
        "UPDATE users SET is_admin = true WHERE false",
        "UPDATE api_tokens SET revoked_at = NULL WHERE false",
        // Who granted or revoked, and the requests, are the console's only;
        // and the gateway changes no grant and no one's groups.
        "SELECT granted_by FROM api_grants LIMIT 1",
        "SELECT revoked_by FROM api_grants LIMIT 1",
        "SELECT from_request FROM api_grants LIMIT 1",
        "SELECT * FROM api_access_requests LIMIT 1",
        "SELECT read_at FROM user_groups LIMIT 1",
        "UPDATE api_grants SET revoked_at = NULL WHERE false",
        "INSERT INTO api_grants (api_id, group_name) VALUES (gen_random_uuid(), 'x')",
        "DELETE FROM user_groups WHERE false",
        "INSERT INTO user_groups (user_id, group_name) VALUES (gen_random_uuid(), 'x')",
      ]) {
        await expect(gateway.query(refused), refused).rejects.toThrow(/permission denied/);
      }
    } finally {
      await gateway.end();
    }
  });

  it("refuses to go on without a role it can sign in as", async () => {
    await expect(ensureGatewayAccess(owner, "vennir_gateway_missing", undefined)).rejects.toThrow("doesn't exist");
  });
});
