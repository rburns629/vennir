// SPDX-License-Identifier: MIT
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { poolConfig } from "./connection.js";
import * as schema from "./schema.js";

const pool = new Pool(poolConfig(config.databasePoolSize));
// An idle connection Postgres closes (a restart, a failover) is an error on
// the pool, not on any request: unheard, Node ends the whole process. The
// pool drops that connection and opens another when one's needed.
pool.on("error", (err) => {
  console.error(JSON.stringify({ level: 50, event: "database_connection_lost", msg: "an idle database connection was closed", err: err.message }));
});

export const db = drizzle(pool, { schema });

/**
 * Runs `work` while this console holds the advisory lock `key`, taken by a
 * transaction kept open for as long as `work` runs and released when it
 * ends; null, without running it, when another console holds it. `work`
 * writes through `db`, outside that transaction, so each of its writes
 * stands at once, even if it doesn't finish. Each key is a constant no one
 * else uses.
 */
export async function whileHolding<T>(key: number, work: () => Promise<T>): Promise<T | null> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${key}) AS locked`);
    if (!locked.rows[0]?.locked) return null;
    return work();
  });
}
