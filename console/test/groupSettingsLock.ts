// SPDX-License-Identifier: MIT
/**
 * The single sign-on settings and everyone's kept groups are one install's,
 * shared by every test file on the test database: a file that changes the
 * settings (sso.test.ts, which empties everyone's kept groups and waiting
 * requests' copies each time where groups come from changes) mustn't run
 * while another relies on kept groups (api-access.test.ts). Each such file
 * holds this Postgres advisory lock for the whole file, so they run one
 * after the other whatever order vitest starts them in.
 */
import pg from "pg";
import { afterAll, beforeAll } from "vitest";

/** Any number, the same in every file that takes it: "sso" in ASCII. */
const KEY = 0x73736f;
/** How long a file waits for the other to finish. */
const WAIT_MS = 10 * 60_000;

/** Holds the lock from before the file's first test until after its last. */
export function holdGroupSettingsLock(): void {
  let client: pg.Client | undefined;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env["DATABASE_URL"] ?? "" });
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [KEY]);
  }, WAIT_MS);
  afterAll(async () => {
    if (!client) return;
    await client.query("SELECT pg_advisory_unlock($1)", [KEY]);
    await client.end();
  });
}
