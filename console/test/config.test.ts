// SPDX-License-Identifier: MIT
/**
 * Startup settings (src/config.ts) that are weak without complaint: a
 * JWT_SECRET under 32 bytes stops startup, and keyless bots are off when
 * there's no audience to check their tokens against. Each case reads the
 * config in a process of its own, since it's read once at import.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { verifiedTlsProblem } from "../src/config.js";

const run = promisify(execFile);

async function load(env: Record<string, string | undefined>): Promise<{ keyless?: { issuers: string[]; audience: string }; error?: string }> {
  const script = `import("./src/config.ts").then(({ config }) => console.log(JSON.stringify({ keyless: config.keyless })), (e) => console.log(JSON.stringify({ error: e.message })))`;
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  const { stdout } = await run("npx", ["tsx", "-e", script], { env: merged as NodeJS.ProcessEnv });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { keyless?: { issuers: string[]; audience: string }; error?: string };
}

describe("the console's settings", () => {
  it("refuse a JWT_SECRET shorter than 32 bytes", async () => {
    expect((await load({ JWT_SECRET: "short-secret" })).error).toMatch(/JWT_SECRET is shorter than 32 bytes/);
    expect((await load({ JWT_SECRET: "x".repeat(32) })).error).toBeUndefined();
  });

  it("send a sign-in token from the cloud only over TLS that checks the server", async () => {
    const ca = join(mkdtempSync(join(tmpdir(), "ca-")), "ca.crt");
    writeFileSync(ca, "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n");
    const remote = "postgresql://console:pw@10.0.0.5:5432/console";
    for (const url of [
      remote,
      `${remote}?sslmode=disable`,
      `${remote}?sslmode=no-verify`,
      `${remote}?sslmode=require&uselibpqcompat=true`,
      // As node-postgres reads them: an empty host= is no host, the last
      // sslmode counts, and nothing after a # is the query.
      `${remote}?host=`,
      `${remote}?sslmode=verify-full&sslmode=disable`,
      `${remote}?x=#&sslmode=verify-full`,
      // A name that only starts like a loopback address.
      "postgresql://console@127.0.0.1.nip.io/console",
      "postgresql://console:pw@localhost/console?host=10.0.0.5",
    ]) {
      const problem = verifiedTlsProblem(url);
      expect(problem, url).toMatch(/TLS that checks the server's certificate/);
      expect(problem, url).not.toMatch(/10\.0\.0\.5|pw/);
    }
    for (const url of [
      `${remote}?sslmode=verify-full`,
      // node-postgres 8 checks the certificate for these too.
      `${remote}?sslmode=require`,
      `${remote}?sslmode=verify-ca&sslrootcert=${ca}&uselibpqcompat=true`,
      "postgresql://console@127.0.0.1:5432/console",
      "postgresql://console@localhost/console",
      "postgresql://console@/console?host=/cloudsql/project:region:instance",
    ]) {
      expect(verifiedTlsProblem(url), url).toBe("");
    }
    // PGHOST is only for a URL with no host of its own; PGSSLMODE only for
    // one that sets no TLS.
    process.env["PGHOST"] = "localhost";
    process.env["PGSSLMODE"] = "verify-full";
    try {
      expect(verifiedTlsProblem("postgresql://console@10.0.0.5/console?sslmode=disable")).toMatch(/checks the server/);
      expect(verifiedTlsProblem("postgresql://console@10.0.0.5/console")).toBe("");
    } finally {
      delete process.env["PGHOST"];
      delete process.env["PGSSLMODE"];
    }
    // And it stops startup, only with IAM sign-in.
    const url = "postgresql://console@10.0.0.5/console";
    expect((await load({ DATABASE_IAM_AUTH: "gcp", DATABASE_URL: url, PGSSLMODE: undefined, PGHOST: undefined })).error).toMatch(/DATABASE_URL: with DATABASE_IAM_AUTH/);
    expect((await load({ DATABASE_IAM_AUTH: undefined, DATABASE_URL: url })).error).toBeUndefined();
  }, 30_000);

  it("turn keyless bots off with no audience, never accepting a constant one", async () => {
    expect((await load({ KEYLESS_AUDIENCE: undefined, CONSOLE_URL: undefined })).keyless).toEqual({ issuers: [], audience: "", noAudience: true });
    expect((await load({ KEYLESS_AUDIENCE: undefined, CONSOLE_URL: "https://vennir.acme.dev/" })).keyless).toEqual({
      issuers: ["https://token.actions.githubusercontent.com", "https://gitlab.com"],
      audience: "https://vennir.acme.dev",
      noAudience: false,
    });
  });
});
