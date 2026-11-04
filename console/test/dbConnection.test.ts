// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { poolConfig } from "../src/db/connection.js";
import { gcpMetadataToken } from "../src/gcpMetadata.js";
import { rdsTokens } from "../src/db/rds.js";

describe("how the console connects to its database", () => {
  const before = config.databaseIamAuth;
  afterEach(() => {
    (config as { databaseIamAuth: string }).databaseIamAuth = before;
  });

  it("uses the URL's password, unless signing in with its cloud identity", () => {
    // Opening a connection is bounded: one opened as Postgres moves fails in seconds, not minutes.
    expect(poolConfig(7)).toEqual({ connectionString: config.databaseUrl, max: 7, connectionTimeoutMillis: 10_000 });
    (config as { databaseIamAuth: string }).databaseIamAuth = "gcp";
    // Each new connection asks for the token (kept until a minute before it
    // expires), and nothing parsed from the URL is left to replace it: a
    // connectionString would, with its empty password.
    const iam = poolConfig(7);
    expect(iam.password).toBe(gcpMetadataToken);
    expect(iam.connectionString).toBeUndefined();
    expect(iam.max).toBe(7);
    expect(iam.connectionTimeoutMillis).toBe(10_000);
    // As node-postgres merges them (connection-parameters.js).
    expect(Object.assign({}, iam).password).toBe(gcpMetadataToken);
  });
});

describe("signing in to Amazon RDS", () => {
  it("signs a token for its server and user with the role's credentials, and keeps it ten minutes", async () => {
    let now = Date.UTC(2026, 9, 29, 12);
    let signings = 0;
    const credentials = () => {
      signings++;
      return Promise.resolve({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" });
    };
    const token = rdsTokens("us-east-2", "db.example.us-east-2.rds.amazonaws.com", 5432, "vennir_console", credentials, () => now);
    const first = await token();
    for (const part of ["db.example.us-east-2.rds.amazonaws.com:5432/?", "Action=connect", "DBUser=vennir_console", "X-Amz-Credential=AKIDEXAMPLE%2F", "%2Fus-east-2%2Frds-db%2Faws4_request", "X-Amz-Expires=900", "X-Amz-Signature="]) {
      expect(first).toContain(part);
    }
    expect(await token()).toBe(first);
    expect(signings).toBe(1);
    now += 11 * 60 * 1000;
    await token();
    expect(signings).toBe(2);
  });
});
