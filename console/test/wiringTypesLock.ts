// SPDX-License-Identifier: MIT
/**
 * The wiring types are one vocabulary for the whole install, and a test
 * that replaces them (ReplaceWiringTypes, a catalog release) removes every
 * other test's. Test files run in parallel, so each one that reads or
 * replaces the vocabulary holds this lock, a Postgres advisory lock on a
 * connection of its own, from its beforeAll to its afterAll.
 */
import pg from "pg";

import { config } from "../src/config.js";

const KEY = "select hashtext('vennir-tests:wiring_types')::bigint as key";

/** Waits for the lock; the function it returns releases it. */
export async function lockWiringTypes(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  await client.query(`select pg_advisory_lock((${KEY}))`);
  return async () => {
    await client.query(`select pg_advisory_unlock((${KEY}))`);
    await client.end();
  };
}
