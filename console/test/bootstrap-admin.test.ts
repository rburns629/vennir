// SPDX-License-Identifier: MIT
/**
 * The first admin (db/bootstrapAdmin.ts): a generated password is never
 * printed, and must be changed at the first sign-in; one the operator set
 * isn't forced, unless they ask (vertra does); and an existing account is
 * never touched.
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "../src/auth/password.js";
import { seedBootstrapAdmin } from "../src/db/bootstrapAdmin.js";
import { db } from "../src/db/client.js";
import { findUserByEmail, setUserPassword } from "../src/db/queries.js";
import { users } from "../src/db/schema.js";

const made: string[] = [];
const email = () => {
  const address = `bootstrap-${randomUUID()}@example.com`;
  made.push(address);
  return address;
};

afterAll(async () => {
  await db.delete(users).where(inArray(users.email, made));
});

describe("the first admin", () => {
  it("gets a random password that is never printed, and must change it", async () => {
    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(line));
    const address = email();
    await seedBootstrapAdmin(db, address, undefined);
    log.mockRestore();

    const admin = await findUserByEmail(address);
    expect(admin).toMatchObject({ isAdmin: true, mustChangePassword: true });
    // vertra apply reads this line to know the account is new.
    expect(printed.join("\n")).toContain(`Bootstrap admin account created: ${address}`);
    expect(printed.join("\n")).toContain("vertra admin reset-password");
    // Nothing printed is shaped like the password (18 random bytes,
    // base64url; BOOTSTRAP_ADMIN_PASSWORD, named, has no lower case).
    expect(printed.join("\n")).not.toMatch(/(^|\s)(?=\S*[a-z])[A-Za-z0-9_-]{24}(\s|$)/);
  });

  it("isn't forced to change a password the operator set", async () => {
    const address = email();
    await seedBootstrapAdmin(db, address, "an-operator-chosen-password");
    const admin = await findUserByEmail(address);
    expect(admin).toMatchObject({ isAdmin: true, mustChangePassword: false });
    expect(await verifyPassword(admin!.passwordHash!, "an-operator-chosen-password")).toBe(true);
  });

  it("must change a given password when asked to (vertra's, saved to a file)", async () => {
    const address = email();
    await seedBootstrapAdmin(db, address, "a-password-vertra-generated", true);
    const admin = await findUserByEmail(address);
    expect(admin).toMatchObject({ isAdmin: true, mustChangePassword: true });
    expect(await verifyPassword(admin!.passwordHash!, "a-password-vertra-generated")).toBe(true);
  });

  it("leaves an existing account alone", async () => {
    const address = email();
    await seedBootstrapAdmin(db, address, "the-first-password");
    const admin = await findUserByEmail(address);
    await setUserPassword(admin!.id, admin!.passwordHash!, false);
    await seedBootstrapAdmin(db, address, undefined);
    expect(await findUserByEmail(address)).toMatchObject({ mustChangePassword: false, passwordHash: admin!.passwordHash });
  });
});
