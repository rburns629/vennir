// SPDX-License-Identifier: MIT
/**
 * Gives an admin a new password, for when the first admin's is lost, or was
 * never known (an install that set no bootstrapAdmin password: the migrate
 * Job gives it a random one it never prints). Run inside the console's own
 * Pod, so only someone the cluster lets exec there can (`vertra admin
 * reset-password`, or `kubectl exec deploy/<release>-execution-console --
 * node dist/db/resetAdmin.js <email>`). The new password is random and
 * printed once, to the exec's own output, which no Pod log keeps; every
 * session the account had is revoked (password_changed_at),
 * and the reset is in the audit log. Only an admin's password: anyone
 * else's is an admin's to reset in the console.
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { appendAuditEntry } from "../audit.js";
import { hashPassword } from "../auth/password.js";
import { config } from "../config.js";
import { poolConfig } from "./connection.js";
import * as schema from "./schema.js";

async function main(): Promise<void> {
  const email = schema.normalEmail(process.argv[2] ?? config.bootstrapAdminEmail);
  const pool = new Pool(poolConfig());
  const db = drizzle(pool);
  try {
    const password = randomBytes(18).toString("base64url");
    const updated = await db
      .update(schema.users)
      .set({ passwordHash: await hashPassword(password), passwordChangedAt: new Date(), mustChangePassword: true })
      .where(and(eq(schema.users.email, email), eq(schema.users.isAdmin, true), eq(schema.users.isBot, false)))
      .returning({ id: schema.users.id });
    if (updated.length === 0) {
      console.error(`No admin ${email} here: only an admin's password is reset this way.`);
      process.exitCode = 2;
      return;
    }
    await appendAuditEntry(db, {
      actorId: null,
      method: "CLI",
      route: "reset-admin-password",
      target: { email },
      status: 200,
      requestId: randomBytes(8).toString("hex"),
    });
    console.log(`New password for ${email}: ${password}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
