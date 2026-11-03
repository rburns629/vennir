// SPDX-License-Identifier: MIT
/** Applies pending migrations, then exits — run once at deploy time (a
 * migration Job, matching kernel/ Helm chart's own migrate-then-serve
 * pattern), not from inside the running server -- and creates the first
 * admin (bootstrapAdmin.ts), and grants the gateway's role what it reads
 * (gatewayAccess.ts). */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { poolConfig } from "./connection.js";
import { seedBootstrapAdmin } from "./bootstrapAdmin.js";
import { ensureGatewayAccess } from "./gatewayAccess.js";

async function main(): Promise<void> {
  const pool = new Pool(poolConfig());
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("Migrations applied.");

  await seedBootstrapAdmin(
    db,
    config.bootstrapAdminEmail,
    config.bootstrapAdminPassword,
    config.bootstrapAdminMustChangePassword,
  );

  if (config.gatewayDatabase.role) {
    await ensureGatewayAccess(pool, config.gatewayDatabase.role, config.gatewayDatabase.password);
    console.log(`The gateway's role (${config.gatewayDatabase.role}) has its grants.`);
  }

  await pool.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
