// SPDX-License-Identifier: MIT
/**
 * ObserveService/GetAuditCopy: the audit log's write-once copy as Observe
 * and the Admin page show it. How far it has gone, what's waiting, and
 * where the chain broke, for everyone signed in; where it goes, for admins.
 */
import { randomUUID } from "node:crypto";
import { asc, desc, eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { compared, compareWithCopy, exportAudit } from "../src/auditExport.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { auditExport, auditLog } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { rpcClient } from "./rpc.js";
import { deleteExpired } from "../src/retention.js";

let app: FastifyInstance;
const { rpc, makeUser, signIn, cleanUp } = rpcClient(() => app);
const prefix = `copy-${randomUUID().slice(0, 6)}`;
const originalExport = { ...config.audit.export };
let originalState: typeof auditExport.$inferSelect | undefined;

type Copy = { enabled: boolean; destination: string; copiedThrough: string; waiting: string; brokenAt: string; problem: string; checkedAt?: string };

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  [originalState] = await db.select().from(auditExport).where(eq(auditExport.id, 1));
});

afterAll(async () => {
  Object.assign(config.audit.export, originalExport);
  await db.delete(auditExport);
  if (originalState) await db.insert(auditExport).values(originalState);
  await db.delete(auditLog).where(like(auditLog.requestId, `${prefix}%`));
  await app.close();
  await cleanUp();
});

async function copyAs(token: string): Promise<Copy> {
  const response = await rpc("ObserveService", "GetAuditCopy", {}, { token });
  expect(response.statusCode).toBe(200);
  return response.json<Copy>();
}

describe("the audit log's copy", () => {
  it("says when this install keeps none", async () => {
    config.audit.export.bucket = "";
    const token = await signIn((await makeUser()).email);
    expect(await copyAs(token)).toMatchObject({ enabled: false, destination: "" });
  });

  it("shows how far it has gone to everyone, and where it goes to admins only", async () => {
    Object.assign(config.audit.export, { bucket: "acme-audit", provider: "gcs", prefix: "vennir-audit/" });
    // An entry of its own to wait: the newest of all may be another file's, which it deletes.
    const [own] = await db
      .insert(auditLog)
      .values({ actorId: null, method: "RPC", route: "waiting", target: {}, status: 200, requestId: `${prefix}-waiting` })
      .returning({ id: auditLog.id });
    const through = (own?.id ?? 1) - 1;
    await db.delete(auditExport);
    await db.insert(auditExport).values({ id: 1, lastId: through, lastHash: "", exportedAt: new Date(), checkedAt: new Date() });

    const admin = await copyAs(await signIn((await makeUser({ admin: true })).email));
    expect(admin).toMatchObject({ enabled: true, destination: "gs://acme-audit/vennir-audit/", copiedThrough: String(through), brokenAt: "0" });
    // At least the newest entry, and the sign-ins since.
    expect(Number(admin.waiting)).toBeGreaterThanOrEqual(1);

    const member = await copyAs(await signIn((await makeUser()).email));
    expect(member).toMatchObject({ enabled: true, destination: "", copiedThrough: String(through) });
  });

  it("names the entry where the chain broke, and copies nothing from there", async () => {
    Object.assign(config.audit.export, { bucket: "acme-audit", provider: "gcs" });
    const token = await signIn((await makeUser()).email);
    const [newest] = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1);
    await db.delete(auditExport);
    await db.insert(auditExport).values({ id: 1, lastId: newest!.id, lastHash: newest!.hash ?? "" });
    // Written behind the console's back: its hash doesn't follow.
    const [forged] = await db
      .insert(auditLog)
      .values({ actorId: null, method: "RPC", route: "forged", target: {}, status: 200, requestId: `${prefix}-forged`, hash: "not-the-chain" })
      .returning();

    expect(await exportAudit(app.log)).toBe(true);
    const copy = await copyAs(token);
    expect(copy.brokenAt).toBe(String(forged!.id));
    expect(copy.problem).toContain(`breaks at entry ${String(forged!.id)}`);
    expect(copy.copiedThrough).toBe(String(newest!.id));
    expect(copy.checkedAt).toBeDefined();
  });
});

describe("the database compared with its copy", () => {
  const real = globalThis.fetch;
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Three entries of this file's, and a GCS bucket holding them as one copy (as the export writes it). */
  async function copied(tag: string) {
    Object.assign(config.audit.export, { bucket: "acme-audit", provider: "gcs", prefix: "vennir-audit/" });
    const rows = await db
      .insert(auditLog)
      .values([1, 2, 3].map((n) => ({ actorId: null, method: "RPC", route: `${tag}-${String(n)}`, target: { n }, status: 200, requestId: `${prefix}-${tag}` })))
      .returning();
    const ids = rows.map((r) => r.id);
    const stored = await db.select().from(auditLog).where(inArray(auditLog.id, ids)).orderBy(asc(auditLog.id));
    const body = stored.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const name = `vennir-audit/2026/10/29/${String(ids[0]).padStart(12, "0")}-${String(ids[2]).padStart(12, "0")}.jsonl`;
    await db.delete(auditExport);
    await db.insert(auditExport).values({ id: 1, comparedThrough: 0 });
    return { ids, name, body };
  }

  function bucket(name: string, body: string | null) {
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("http://metadata.google.internal/")) return Promise.resolve(Response.json({ access_token: "t", expires_in: 3600 }));
      if (url.includes("/storage/v1/b/acme-audit/o?")) return Promise.resolve(Response.json({ items: [{ name }] }));
      if (url.includes(`/o/${encodeURIComponent(name)}?alt=media`)) {
        return Promise.resolve(body === null ? new Response("forbidden", { status: 403 }) : new Response(body));
      }
      return real(input, init);
    });
  }

  const state = async () => (await db.select().from(auditExport).where(eq(auditExport.id, 1)))[0];

  it("moves on while they agree", async () => {
    const { ids, name, body } = await copied("same");
    bucket(name, body);
    await compareWithCopy(app.log);
    expect(await state()).toMatchObject({ comparedThrough: ids[2], differsAt: null, compareProblem: null });
  });

  it("compares the entry, not the row: a column audit_log gains or loses later changes nothing", async () => {
    const { ids, name, body } = await copied("columns");
    // Copied by a release whose audit_log had a column since dropped.
    const lines = body
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.stringify({ ...(JSON.parse(line) as Record<string, unknown>), droppedColumn: "x" }));
    bucket(name, lines.join("\n") + "\n");
    await compareWithCopy(app.log);
    expect(await state()).toMatchObject({ comparedThrough: ids[2], differsAt: null, compareProblem: null });
    // And a column added since: the row has it, its copy doesn't.
    const [row] = await db.select().from(auditLog).where(eq(auditLog.id, ids[0]!));
    expect(compared({ ...row, addedColumn: null })).toBe(compared(JSON.parse(body.split("\n")[0]!) as Record<string, unknown>));
  });

  it("names an entry changed after it was copied, its hashes rewritten or not", async () => {
    const { ids, name, body } = await copied("changed");
    bucket(name, body);
    await db.update(auditLog).set({ route: "rewritten", hash: "recomputed" }).where(eq(auditLog.id, ids[1]!));
    await compareWithCopy(app.log);
    const after = await state();
    expect(after?.differsAt).toBe(ids[1]);
    expect(after?.compareProblem).toContain(`entry ${String(ids[1])} differs in the database`);
  });

  it("names an entry gone from the database", async () => {
    const { ids, name, body } = await copied("gone");
    bucket(name, body);
    await db.delete(auditLog).where(eq(auditLog.id, ids[0]!));
    await compareWithCopy(app.log);
    expect((await state())?.compareProblem).toContain(`entry ${String(ids[0])} is gone from the database`);
  });

  it("expects an entry past retention to be gone from the database", async () => {
    const { ids, name, body } = await copied("retained");
    // The first copied a decade ago, and since deleted by retention.
    const lines = body.split("\n");
    lines[0] = JSON.stringify({ ...(JSON.parse(lines[0]!) as Record<string, unknown>), at: "2016-01-01T00:00:00.000Z" });
    bucket(name, lines.join("\n"));
    await db.delete(auditLog).where(eq(auditLog.id, ids[0]!));
    await compareWithCopy(app.log);
    expect(await state()).toMatchObject({ comparedThrough: ids[2], differsAt: null, compareProblem: null });
  });

  it("is never shortened by retention past what's been copied", async () => {
    // Here, where this file owns the export's row: an entry old enough to
    // go, but after the last one copied, stays.
    Object.assign(config.audit.export, { bucket: "acme-audit", provider: "gcs" });
    const [row] = await db
      .insert(auditLog)
      .values({ actorId: null, method: "RPC", route: "uncopied", status: 200, requestId: `${prefix}-uncopied`, at: new Date("2000-01-01T00:00:00Z") })
      .returning();
    try {
      await db.delete(auditExport);
      await db.insert(auditExport).values({ id: 1, lastId: row!.id - 1 });
      await deleteExpired();
      expect(await db.select().from(auditLog).where(eq(auditLog.id, row!.id))).toHaveLength(1);
    } finally {
      await db.delete(auditLog).where(eq(auditLog.id, row!.id));
    }
  });

  it("says when it can't read the copy, without calling that a difference", async () => {
    const { name } = await copied("unread");
    bucket(name, null);
    await compareWithCopy(app.log);
    const after = await state();
    expect(after?.differsAt).toBeNull();
    expect(after?.compareProblem).toContain(`couldn't read ${name}`);
  });
});
