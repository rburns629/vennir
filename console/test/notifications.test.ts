// SPDX-License-Identifier: MIT
/**
 * Notifications (src/notifier.ts, src/core/notifications.ts): who's told
 * what, once (a run, an approval, a step the cluster refused, a platform
 * alert); a team's webhook URL kept encrypted, only to allowed hosts,
 * never sent back, and set only by its maintainers; posting, and what a
 * failed post leaves. kernel-api and fetch are stubbed; the rest is the
 * real console on the real test database.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, recordSubmittedExecution } from "../src/db/queries.js";
import { notificationEvents, notificationSettings, teams, teamWebhooks, userNotifications, users as usersTable, webhookDeliveries } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { listAwaitingApproval, listRefusals } from "../src/kernel/client.js";
import { policySyncOutcomes } from "../src/policySync.js";
import { auditExportStatus } from "../src/auditExport.js";
import { config } from "../src/config.js";
import {
  decryptUrl,
  deliverEmails,
  deliverWebhooks,
  encryptUrl,
  notify,
  notifyApprovals,
  notifyAuditCopy,
  notifyPolicySync,
  notifyRefusals,
  platformAlert,
  runFinished,
  webhookUrlProblem,
} from "../src/notifier.js";
import { caller, rpcClient } from "./rpc.js";

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("nodemailer", () => ({
  createTransport: vi.fn(() => ({ sendMail: vi.fn((mail: { to: string; subject: string; text: string }) => { sent.push(mail); return Promise.resolve({}); }) })),
}));
vi.mock("../src/kernel/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kernel/client.js")>()),
  listAwaitingApproval: vi.fn(() => Promise.resolve([])),
  listRefusals: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../src/auditExport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auditExport.js")>()),
  auditExportStatus: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("../src/policySync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/policySync.js")>()),
  policySyncOutcomes: vi.fn(() => ({})),
}));

const prefix = `ntf-${randomUUID().slice(0, 6)}`;
const team = `${prefix}-team`;
const SLACK = "https://hooks.slack.com/services/T000/B000/s3cr3tpart";

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
let maintainer: { id: string; email: string };
let member: { id: string; email: string };
let maintainerToken: string;
let memberToken: string;
let teamId: string;
const silent = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Parameters<typeof deliverWebhooks>[0];

const inbox = async (userId: string) =>
  db
    .select({ title: notificationEvents.title, key: notificationEvents.key })
    .from(userNotifications)
    .innerJoin(notificationEvents, eq(notificationEvents.id, userNotifications.eventId))
    .where(eq(userNotifications.userId, userId));

beforeAll(async () => {
  app = await buildApp();
  teamId = (await createTeam(team)).id;
  maintainer = await users.makeUser();
  member = await users.makeUser();
  await addTeamMember(maintainer.id, teamId, "maintainer");
  await addTeamMember(member.id, teamId, "member");
  [maintainerToken, memberToken] = await Promise.all([maintainer, member].map((u) => users.signIn(u.email)));
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.delete(notificationEvents).where(like(notificationEvents.key, `%${prefix}%`));
  await db.delete(notificationEvents).where(like(notificationEvents.key, "refused:%"));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

describe("a webhook URL", () => {
  it("is kept encrypted, and can't be read once changed", () => {
    const stored = encryptUrl(SLACK);
    expect(stored).not.toContain("s3cr3t");
    expect(decryptUrl(stored)).toBe(SLACK);
    const [v, iv, tag, data = ""] = stored.split(".");
    // One character changed (to another one: "A" when it was already "A" would be no change).
    const changed = `${data.startsWith("A") ? "B" : "A"}${data.slice(1)}`;
    expect(decryptUrl([v, iv, tag, changed].join("."))).toBeNull();
  });

  it("goes only to an allowed chat host, over https", () => {
    expect(webhookUrlProblem(SLACK)).toBeNull();
    expect(webhookUrlProblem("https://acme.webhook.office.com/webhookb2/x")).toBeNull();
    expect(webhookUrlProblem("http://hooks.slack.com/services/x")).toMatch(/https/);
    expect(webhookUrlProblem("https://kernel-api.vennir-system.svc/x")).toMatch(/only go to/);
    expect(webhookUrlProblem("https://hooks.slack.com.evil.example/x")).toMatch(/only go to/);
    expect(webhookUrlProblem("https://u:p@hooks.slack.com/x")).toMatch(/user name/);
  });
});

describe("a team's webhook", () => {
  it("is set by a maintainer, never sent back, and seen by members by its host", async () => {
    expect((await call(memberToken, "NotificationService/SetTeamWebhook", { team, url: SLACK, kinds: ["run_failed"] })).code).toBe("permission_denied");
    const refused = await call(maintainerToken, "NotificationService/SetTeamWebhook", { team, url: "https://example.com/hook", kinds: ["run_failed"] });
    expect(refused.failure).toBe("WEBHOOK_URL");
    const set = await call(maintainerToken, "NotificationService/SetTeamWebhook", { team, url: SLACK, kinds: ["run_failed", "approval_waiting"] });
    expect(set.code).toBe("ok");
    const seen = await call(memberToken, "NotificationService/GetTeamWebhook", { team });
    expect(seen.body).toMatchObject({ webhook: { configured: true, host: "hooks.slack.com", kinds: ["run_failed", "approval_waiting"] } });
    expect(JSON.stringify([set.body, seen.body])).not.toContain("s3cr3t");
    const [row] = await db.select().from(teamWebhooks).where(eq(teamWebhooks.teamId, teamId));
    expect(row?.urlEncrypted).not.toContain("s3cr3t");
    // Changing only the kinds keeps the URL.
    await call(maintainerToken, "NotificationService/SetTeamWebhook", { team, kinds: ["run_failed", "approval_waiting"] });
    const [kept] = await db.select().from(teamWebhooks).where(eq(teamWebhooks.teamId, teamId));
    expect(decryptUrl(kept?.urlEncrypted ?? "")).toBe(SLACK);
    expect((await call(maintainerToken, "NotificationService/SetTeamWebhook", { team, kinds: ["run_succeeded"] })).code).toBe("invalid_argument");
  });
});

describe("a finished run", () => {
  it("tells whoever ran it once, and posts a failure to its team's webhook", async () => {
    const executionId = randomUUID();
    const run = { executionId, name: `${prefix} deploy`, state: "FAILED", submittedBy: member.id, teams: [team], finishedAt: new Date().toISOString(), failedStep: { taskId: "deploy", code: "QUOTA" } };
    await runFinished(run);
    await runFinished(run);
    expect((await inbox(member.id)).filter((n) => n.key.includes(executionId)).map((n) => n.title)).toEqual([`${prefix} deploy failed`]);
    const [event] = await db.select().from(notificationEvents).where(like(notificationEvents.key, `run:${executionId}%`));
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, event?.id ?? ""))).toHaveLength(1);

    const posted: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init: { body: string; redirect: string }) => {
      posted.push({ url, body: JSON.parse(init.body) as unknown, redirect: init.redirect });
      return Promise.resolve(new Response("ok"));
    }));
    expect(await deliverWebhooks(silent)).toBeGreaterThanOrEqual(1);
    expect(posted).toContainEqual({ url: SLACK, body: { text: expect.stringContaining(`${prefix} deploy failed`) as unknown }, redirect: "error" });
    // Posted once.
    posted.length = 0;
    await deliverWebhooks(silent);
    expect(posted).toEqual([]);
  });

  it("isn't news when it finished long ago, and a success isn't posted", async () => {
    const old = randomUUID();
    await runFinished({ executionId: old, name: "old", state: "SUCCEEDED", submittedBy: member.id, teams: [team], finishedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    expect(await db.select().from(notificationEvents).where(like(notificationEvents.key, `run:${old}%`))).toEqual([]);
    const ok = randomUUID();
    await runFinished({ executionId: ok, name: `${prefix} ok`, state: "SUCCEEDED", submittedBy: member.id, teams: [team], finishedAt: new Date().toISOString() });
    const [event] = await db.select().from(notificationEvents).where(like(notificationEvents.key, `run:${ok}%`));
    expect(event?.title).toBe(`${prefix} ok finished`);
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, event?.id ?? ""))).toEqual([]);
  });

  it("is posted once when two consoles' passes run at once", async () => {
    const executionId = randomUUID();
    await runFinished({ executionId, name: `${prefix} overlap`, state: "FAILED", submittedBy: member.id, teams: [team], finishedAt: new Date().toISOString() });
    const posted: string[] = [];
    // Slow enough that the second pass starts while the first is posting.
    vi.stubGlobal("fetch", vi.fn((_url: string, init: { body: string }) => new Promise<Response>((resolve) => {
      setTimeout(() => {
        posted.push(init.body);
        resolve(new Response("ok"));
      }, 200);
    })));
    const counts = await Promise.all([deliverWebhooks(silent), deliverWebhooks(silent)]);
    expect(posted.filter((body) => body.includes(`${prefix} overlap`))).toHaveLength(1);
    // One pass posted; the other found it posting and left.
    expect(counts.filter((n) => n === 0)).toHaveLength(1);
    // The pass that left doesn't post it later.
    await deliverWebhooks(silent);
    expect(posted.filter((body) => body.includes(`${prefix} overlap`))).toHaveLength(1);
  });

  it("leaves a failed post to be tried again, and says why", async () => {
    await runFinished({ executionId: randomUUID(), name: `${prefix} again`, state: "FAILED", submittedBy: member.id, teams: [team], finishedAt: new Date().toISOString() });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("no", { status: 404 }))));
    await deliverWebhooks(silent);
    const [row] = await db.select().from(teamWebhooks).where(eq(teamWebhooks.teamId, teamId));
    expect(row?.lastError).toBe("The webhook answered 404.");
    expect((await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.teamId, teamId))).some((d) => d.sentAt === null && d.attempts === 1)).toBe(true);
  });
});

describe("a step waiting for an approval", () => {
  it("tells its team's maintainers, but not whoever ran it", async () => {
    const executionId = randomUUID();
    const bot = await users.makeUser();
    await db.update(usersTable).set({ isBot: true }).where(eq(usersTable.id, bot.id));
    await addTeamMember(bot.id, teamId, "maintainer");
    vi.mocked(listAwaitingApproval).mockResolvedValue([
      { executionId, executionName: `${prefix} prod`, taskId: "deploy", team, image: "i", action: "create", requestedBy: `user:${maintainer.id}`, awaitingSince: new Date().toISOString() },
    ]);
    const other = await users.makeUser();
    await addTeamMember(other.id, teamId, "maintainer");
    await notifyApprovals();
    await notifyApprovals();
    const told = await db
      .select({ userId: userNotifications.userId })
      .from(userNotifications)
      .innerJoin(notificationEvents, eq(notificationEvents.id, userNotifications.eventId))
      .where(like(notificationEvents.key, `approval:${executionId}%`));
    expect(told.map((t) => t.userId)).toEqual([other.id]);
  });
});

describe("a step the cluster refused", () => {
  it("tells admins and whoever ran it, once, and posts it to its team's webhook if it wants these", async () => {
    const admin = await users.makeUser({ admin: true });
    await call(maintainerToken, "NotificationService/SetTeamWebhook", { team, kinds: ["run_failed", "step_refused"] });
    const executionId = randomUUID();
    await recordSubmittedExecution({ executionId, teams: [team], submittedBy: member.id, name: `${prefix} unsigned`, payload: {} });
    vi.mocked(listRefusals).mockResolvedValue([
      { executionId, taskId: "deploy", team, image: "reg/x@sha256:aa", code: "IMAGE_NOT_SIGNED", message: "denied", at: new Date().toISOString() },
    ]);
    // Made once, whichever pass makes it (the app's own notifier runs too).
    expect((await notifyRefusals()) + (await notifyRefusals())).toBeLessThanOrEqual(1);
    for (const who of [admin, member]) {
      expect((await inbox(who.id)).filter((n) => n.key.startsWith(`refused:${executionId}`)).map((n) => n.title)).toEqual([
        `${team} step deploy was refused: IMAGE_NOT_SIGNED`,
      ]);
    }
    expect((await inbox(maintainer.id)).some((n) => n.key.startsWith(`refused:${executionId}`))).toBe(false);
    const [event] = await db.select().from(notificationEvents).where(like(notificationEvents.key, `refused:${executionId}%`));
    expect(event?.body).toContain("isn't signed by the catalog's CI");
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, event?.id ?? ""))).toHaveLength(1);
    vi.mocked(listRefusals).mockResolvedValue([]);
  });
});

describe("a platform alert", () => {
  it("tells admins only, once, saying who did it", async () => {
    const admin = await users.makeUser({ admin: true });
    const key = `${prefix}-purge`;
    expect(await platformAlert(key, "Team x was purged", "Its people are gone.", maintainer.id)).toBe(true);
    expect(await platformAlert(key, "Team x was purged", "Its people are gone.", maintainer.id)).toBe(false);
    const [event] = await db.select().from(notificationEvents).where(eq(notificationEvents.key, `platform:${key}`));
    expect(event?.body).toBe(`Its people are gone. By ${maintainer.email}.`);
    expect((await inbox(admin.id)).some((n) => n.key === `platform:${key}`)).toBe(true);
    expect((await inbox(member.id)).some((n) => n.key === `platform:${key}`)).toBe(false);
  });

  it("is posted to the admins' channel too, a team an admin chooses, when its webhook asks for it", async () => {
    const admin = await users.makeUser({ admin: true });
    const adminToken = await users.signIn(admin.email);
    // Only admins choose it; until then the team's webhook can't ask for admins' kinds.
    expect((await call(maintainerToken, "NotificationService/SetAdminChannel", { team })).code).toBe("permission_denied");
    expect((await call(maintainerToken, "NotificationService/SetTeamWebhook", { team, kinds: ["run_failed", "platform_alert"] })).code).toBe("invalid_argument");
    expect((await call(adminToken, "NotificationService/SetAdminChannel", { team })).code).toBe("ok");
    expect((await call(adminToken, "NotificationService/GetAdminChannel", {})).body).toEqual({ team });
    expect((await call(memberToken, "NotificationService/GetTeamWebhook", { team })).body).toMatchObject({ adminChannel: true });
    expect((await call(maintainerToken, "NotificationService/SetTeamWebhook", { team, kinds: ["run_failed", "platform_alert"] })).code).toBe("ok");

    const key = `${prefix}-channel`;
    await platformAlert(key, "The allowed image sources changed", "Now: x.");
    const [event] = await db.select().from(notificationEvents).where(eq(notificationEvents.key, `platform:${key}`));
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, event?.id ?? ""))).toHaveLength(1);

    expect((await call(adminToken, "NotificationService/SetAdminChannel", { team: "" })).code).toBe("ok");
    await db.delete(notificationSettings);
  });

  it("reaches everyone who still has an account, one deleted meanwhile or not", async () => {
    const key = `${prefix}-gone`;
    expect(await notify({ key, kind: "platform_alert", title: "x", userIds: [member.id, randomUUID()], teams: [] })).toBe(true);
    expect((await inbox(member.id)).some((n) => n.key === key)).toBe(true);
  });

  it("is made for a policy sync failing for ten minutes, not for one bad pass", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const long = new Date(Date.now() - 11 * 60_000).toISOString();
    vi.mocked(policySyncOutcomes).mockReturnValue({
      identityPolicy: { applies: true, ok: false, at: recent, error: "forbidden", failingSince: recent },
      [`${prefix}Policy`]: { applies: true, ok: false, at: recent, error: `${prefix} forbidden`, failingSince: long },
      pullSecrets: { applies: true, ok: true, at: recent },
    });
    expect((await notifyPolicySync()) + (await notifyPolicySync())).toBeLessThanOrEqual(1);
    const day = new Date().toISOString().slice(0, 10);
    const [event] = await db.select().from(notificationEvents).where(eq(notificationEvents.key, `platform:policy:${prefix}Policy:${day}`));
    expect(event?.title).toBe(`The ${prefix}Policy isn't being synced to the cluster`);
    vi.mocked(policySyncOutcomes).mockReturnValue({});
  });

  it("is made when the audit log's copy breaks, differs, or stops copying for half an hour", async () => {
    const admin = await users.makeUser({ admin: true });
    const entry = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
    const copy = (fields: Partial<NonNullable<Awaited<ReturnType<typeof auditExportStatus>>>>) => ({
      lastId: 1, lastHash: "h", exportedAt: null, checkedAt: null, error: null, brokenAt: null,
      comparedThrough: 0, comparedAt: null, differsAt: null, compareProblem: null, ...fields,
    });
    const has = async (key: string) => (await inbox(admin.id)).some((n) => n.key === `platform:${key}`);

    // Not copying for a minute isn't news; for half an hour it is.
    const day = new Date().toISOString().slice(0, 10);
    await db.delete(notificationEvents).where(eq(notificationEvents.key, `platform:audit-copying:${day}`)); // an earlier run's, today
    vi.mocked(auditExportStatus).mockResolvedValue(copy({ error: "couldn't write to the bucket: denied", exportedAt: new Date(Date.now() - 60_000) }));
    expect(await notifyAuditCopy()).toBe(0);
    vi.mocked(auditExportStatus).mockResolvedValue(copy({ error: "couldn't write to the bucket: denied", exportedAt: new Date(Date.now() - 31 * 60_000) }));
    expect(await notifyAuditCopy()).toBe(1);
    expect(await has(`audit-copying:${day}`)).toBe(true);
    // Never copied at all: at once, though every failed try moves checkedAt.
    await db.delete(notificationEvents).where(eq(notificationEvents.key, `platform:audit-copying:${day}`));
    vi.mocked(auditExportStatus).mockResolvedValue(copy({ error: "couldn't write to the bucket: denied", checkedAt: new Date() }));
    expect(await notifyAuditCopy()).toBe(1);
    const [never] = await db.select().from(notificationEvents).where(eq(notificationEvents.key, `platform:audit-copying:${day}`));
    expect(never?.body).toMatch(/^Nothing has been copied yet: /);

    // A broken chain and a differing entry: at once, and each once.
    vi.mocked(auditExportStatus).mockResolvedValue(copy({ error: "the chain breaks", brokenAt: entry, differsAt: entry + 1, compareProblem: `audit entry ${String(entry + 1)} differs` }));
    expect(await notifyAuditCopy()).toBe(2);
    expect(await notifyAuditCopy()).toBe(0);
    expect(await has(`audit-broken:${String(entry)}`)).toBe(true);
    const [differs] = await db.select().from(notificationEvents).where(eq(notificationEvents.key, `platform:audit-differs:${String(entry + 1)}`));
    expect(differs).toMatchObject({ title: "An audit log entry differs from its write-once copy", body: `audit entry ${String(entry + 1)} differs`, link: "/admin/audit" });

    // No copy configured: nothing.
    vi.mocked(auditExportStatus).mockResolvedValue(null);
    expect(await notifyAuditCopy()).toBe(0);
  });
});

describe("the inbox", () => {
  it("lists your own, counts what's unread, and marks it read", async () => {
    const listed = await call<{ notifications?: { id: string; read: boolean }[]; unreadCount?: number }>(memberToken, "NotificationService/ListNotifications");
    expect(listed.body.unreadCount).toBeGreaterThanOrEqual(2);
    const first = listed.body.notifications?.[0]?.id ?? "";
    await call(memberToken, "NotificationService/MarkNotificationsRead", { ids: [first] });
    // Someone else's can't be marked: nothing happens.
    await call(maintainerToken, "NotificationService/MarkNotificationsRead", { all: true });
    const after = await call<{ unreadCount?: number }>(memberToken, "NotificationService/ListNotifications");
    expect(after.body.unreadCount).toBe((listed.body.unreadCount ?? 0) - 1);
    await call(memberToken, "NotificationService/MarkNotificationsRead", { all: true });
    expect((await call<{ unreadCount?: number }>(memberToken, "NotificationService/ListNotifications")).body.unreadCount ?? 0).toBe(0);
    expect(await inbox(member.id)).not.toHaveLength(0);
    expect(await db.select().from(userNotifications).where(inArray(userNotifications.userId, [member.id]))).not.toHaveLength(0);
  });
});

describe("email", () => {
  it("sends what each person wants of theirs, once, when the install sends email", async () => {
    Object.assign(config.notifications.email, { host: "smtp.example.test", from: "Vennir <vennir@example.test>" });
    const consoleUrl = config.consoleUrl;
    Object.assign(config, { consoleUrl: "https://vennir.example.test" });
    try {
      // The member keeps the defaults (failures among them); the maintainer wants none.
      expect((await call(maintainerToken, "NotificationService/SetEmailPreferences", { kinds: [] })).code).toBe("ok");
      expect((await call(maintainerToken, "NotificationService/SetEmailPreferences", { kinds: ["everything"] })).code).toBe("invalid_argument");
      const prefs = await call<{ available?: boolean; kinds?: string[] }>(memberToken, "NotificationService/GetEmailPreferences");
      expect(prefs.body).toEqual({ available: true, kinds: ["run_failed", "approval_waiting", "product_not_ready", "catalog_failing", "step_refused", "platform_alert"] });

      const executionId = randomUUID();
      await runFinished({ executionId, name: `${prefix} mailed`, state: "FAILED", submittedBy: member.id, teams: [], finishedAt: new Date().toISOString() });
      await runFinished({ executionId: randomUUID(), name: `${prefix} unmailed`, state: "FAILED", submittedBy: maintainer.id, teams: [], finishedAt: new Date().toISOString() });
      sent.length = 0;
      // Two consoles' passes at once, then another: each is sent once.
      await Promise.all([deliverEmails(silent), deliverEmails(silent)]);
      await deliverEmails(silent);
      const ours = sent.filter((m) => m.subject.startsWith(prefix));
      expect(ours.map((m) => [m.to, m.subject])).toEqual([[member.email, `${prefix} mailed failed`]]);
      expect(ours[0]?.text).toContain(`https://vennir.example.test/runs/${executionId}`);
    } finally {
      Object.assign(config, { consoleUrl });
      Object.assign(config.notifications.email, { host: "", from: "" });
    }
  });
});
