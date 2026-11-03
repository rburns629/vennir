// SPDX-License-Identifier: MIT
/**
 * Ensures a first-login account exists after a brand-new install, so
 * standing up the system doesn't require an out-of-band bootstrap step.
 * Idempotent -- only creates the account if its email doesn't already
 * exist, so re-running migrations (a Helm upgrade, a local re-run) never
 * touches an admin password someone already changed.
 *
 * Deliberately never a hardcoded password: BOOTSTRAP_ADMIN_PASSWORD is
 * read the same way every other credential in this system flows in (an
 * env var / mounted Secret at deploy time, never baked into the image or
 * committed to git — see CLAUDE.md's security section). `vertra apply`
 * generates it and hands it over in a Secret of its own
 * (bootstrapAdmin.existingSecret), keeping the only other copy in a file
 * only its operator can read. If it isn't set, the account gets a random
 * password that is never printed: a migration Job's log is shipped to
 * wherever the cluster keeps logs (Cloud Logging, Loki) and kept there, so
 * whoever could read it there could sign in first. Its owner gives it one
 * with `vertra admin reset-password` (db/resetAdmin.ts, run in the
 * console's Pod). A generated password, or one the operator asked to be
 * changed (BOOTSTRAP_ADMIN_MUST_CHANGE_PASSWORD, as vertra does), must be
 * changed at the first sign-in (users.must_change_password); a password
 * the operator set themselves (kind's fixed local one) isn't forced.
 *
 * Takes the `db` the migration runner already opened, rather than
 * importing db/queries.ts (which opens its own separate connection pool,
 * one a one-shot script would then have to know to close too).
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { hashPassword } from "../auth/password.js";
import * as schema from "./schema.js";

export async function seedBootstrapAdmin<S extends Record<string, unknown>>(
  db: NodePgDatabase<S>,
  email: string,
  givenPassword: string | undefined,
  mustChangePassword = false,
): Promise<void> {
  email = email.trim().toLowerCase();
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing) return;

  const password = givenPassword ?? randomBytes(18).toString("base64url");
  await db.insert(schema.users).values({
    email,
    passwordHash: await hashPassword(password),
    isAdmin: true,
    mustChangePassword: mustChangePassword || givenPassword === undefined,
  });

  // vertra apply reads this line (never a password) to know the account is new.
  console.log(`Bootstrap admin account created: ${email}`);
  if (givenPassword === undefined) {
    // Never the password itself: this log outlives the Job.
    console.log(
      "No BOOTSTRAP_ADMIN_PASSWORD was set, so its password is random and shown nowhere. " +
        "Give it one with `vertra admin reset-password`, or in the console's own Pod: " +
        `kubectl exec deploy/<release>-execution-console -- node dist/db/resetAdmin.js ${email}`,
    );
  }
}
