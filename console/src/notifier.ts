// SPDX-License-Identifier: MIT
/**
 * Notifications: telling people what happened, in the console's inbox and on
 * their teams' chat webhooks.
 *
 *   - a run that failed: whoever ran it, and its teams' webhooks;
 *   - a run that succeeded: whoever ran it;
 *   - a step waiting for an approval: its team's maintainers (not whoever
 *     ran it, who can't decide) and its team's webhook;
 *   - the catalog not pulled: admins;
 *   - a step the cluster refused (an image unsigned, unscanned or from an
 *     unallowed source, an identity it isn't registered for): admins,
 *     whoever ran it, and its team's webhook;
 *   - a platform change or fault (a team purged, the allowed image sources
 *     changed, a policy sync failing, a run's image gone, the audit log's
 *     write-once copy not copying, its chain broken or a copy differing):
 *     admins.
 *
 * Each is shown in its people's inbox, emailed to those who want its kind
 * (users.email_kinds) when the install sends email (SMTP_*), and posted to
 * its teams' webhooks. Each is an event made once (notification_events.key), so a second
 * console or a second pass never says it twice. A finished run is reported
 * by resourceRecorder.ts as it records it; the rest are looked for every 30
 * seconds, when webhooks are posted too, each up to five times.
 *
 * A webhook URL is a credential: it's kept encrypted (AES-256-GCM, with a
 * key derived from the console's JWT_SECRET, so a copy of the database
 * alone doesn't give it away), never sent back, and only to the hosts the
 * install allows (config.notifications.webhookHosts), without following
 * redirects. Rotating JWT_SECRET makes the stored ones unreadable: teams set
 * theirs again.
 */
import type { FastifyBaseLogger } from "fastify";
import { readFile } from "node:fs/promises";
import { createTransport, type Transporter } from "nodemailer";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { config } from "./config.js";
import { seal, unseal } from "./sealed.js";
import { backendAllowed } from "./core/apis.js";
import { db, whileHolding } from "./db/client.js";
import {
  catalogSync,
  emailDeliveries,
  notificationEvents,
  notificationSettings,
  teamMemberships,
  teams,
  teamWebhooks,
  userNotifications,
  users,
  webhookDeliveries,
  type NotificationKind,
} from "./db/schema.js";
import { findSubmittedExecutions } from "./db/queries.js";
import { PLATFORM_ERRORS } from "./failureHelp.js";
import { listAwaitingApproval, listRefusals } from "./kernel/client.js";
import { deliverCallbacks } from "./callbacks.js";
import { policySyncOutcomes } from "./policySync.js";
import { auditExportStatus } from "./auditExport.js";
import { notDecidersOfRuns } from "./core/approvals.js";

const MAX_ATTEMPTS = 5;
/** A finished run older than this when it's recorded isn't news (a console's first pass over old runs). */
const NEWS_MS = 60 * 60_000;
/** The catalog failing for this long is worth telling admins. */
const CATALOG_GRACE_MS = 30 * 60_000;
/** A policy sync failing for this long is (one bad pass isn't). */
const POLICY_GRACE_MS = 10 * 60_000;
/** The audit log's copy not copying for this long is, too. */
const AUDIT_GRACE_MS = 30 * 60_000;

// --- the webhook URL, encrypted ---

const PURPOSE = "notification webhook urls";

export function encryptUrl(url: string): string {
  return seal(url, PURPOSE);
}

/** The URL, or null when it can't be read (JWT_SECRET changed since). */
export function decryptUrl(stored: string): string | null {
  return unseal(stored, PURPOSE);
}

/** Why a webhook URL can't be used, or null. */
export function webhookUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That isn't a URL.";
  }
  if (parsed.protocol !== "https:") return "A webhook URL starts with https://.";
  if (parsed.username || parsed.password) return "A webhook URL has no user name or password in it.";
  if (!backendAllowed(url, config.notifications.webhookHosts)) {
    return `Webhooks may only go to ${config.notifications.webhookHosts.join(", ")} (the install's notifications.webhookHosts).`;
  }
  return null;
}

// --- making events ---

export interface NewEvent {
  key: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;
  /** Who sees it in the console. */
  userIds: string[];
  /** Whose webhooks it's posted to, when they want this kind. */
  teams: string[];
}

/** Makes an event, unless it was made already; returns whether it was new. */
export async function notify(event: NewEvent): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [made] = await tx
      .insert(notificationEvents)
      .values({ key: event.key, kind: event.kind, title: event.title.slice(0, 300), body: (event.body ?? "").slice(0, 2000), link: event.link ?? null })
      .onConflictDoNothing({ target: notificationEvents.key })
      .returning({ id: notificationEvents.id });
    if (!made) return false;
    const userIds = [...new Set(event.userIds)];
    if (userIds.length > 0) {
      // Only accounts that still exist: one deleted since its id was read
      // isn't told (nor fails the event for everyone else). Locked until
      // this commits, so one deleted meanwhile is skipped, not a foreign key
      // error.
      await tx
        .insert(userNotifications)
        .select(
          tx
            .select({ eventId: sql<string>`${made.id}::uuid`.as("event_id"), userId: users.id, readAt: sql<null>`null`.as("read_at") })
            .from(users)
            .where(inArray(users.id, userIds))
            .for("key share"),
        )
        .onConflictDoNothing();
      // By email too, to those who want this kind, when the install sends email.
      if (config.notifications.email.host) {
        const wanting = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, userIds), sql`${event.kind} = any(${users.emailKinds})`));
        if (wanting.length > 0) {
          await tx.insert(emailDeliveries).values(wanting.map((u) => ({ eventId: made.id, userId: u.id }))).onConflictDoNothing();
        }
      }
    }
    if (event.teams.length > 0) {
      const hooked = await tx
        .select({ teamId: teamWebhooks.teamId })
        .from(teamWebhooks)
        .innerJoin(teams, eq(teams.id, teamWebhooks.teamId))
        .where(and(inArray(teams.name, [...new Set(event.teams)]), sql`${event.kind} = any(${teamWebhooks.kinds})`));
      if (hooked.length > 0) {
        await tx.insert(webhookDeliveries).values(hooked.map((h) => ({ eventId: made.id, teamId: h.teamId }))).onConflictDoNothing();
      }
    }
    return true;
  });
}

/** People who'd want it, of these: not bots, which read no inbox. */
async function people(ids: (string | null)[]): Promise<string[]> {
  const wanted = ids.filter((id): id is string => id !== null);
  if (wanted.length === 0) return [];
  const rows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, wanted), eq(users.isBot, false)));
  return rows.map((r) => r.id);
}

export interface FinishedRun {
  executionId: string;
  name: string;
  state: string;
  submittedBy: string | null;
  /** The teams it was for: a template run's team (or none), a DAG's teams. */
  teams: string[];
  /** When it finished, as the kernel says. */
  finishedAt: string | null;
  /** The step that failed, and why, if one did. */
  failedStep?: { taskId: string; code: string } | undefined;
}

/** A run that just finished (resourceRecorder.ts calls this as it records one). */
export async function runFinished(run: FinishedRun): Promise<void> {
  if (run.state !== "FAILED" && run.state !== "SUCCEEDED") return;
  const at = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
  if (!Number.isFinite(at) || Date.now() - at > NEWS_MS) return;
  const failed = run.state === "FAILED";
  await notify({
    key: `run:${run.executionId}:${run.state}:${run.finishedAt ?? ""}`,
    kind: failed ? "run_failed" : "run_succeeded",
    title: failed ? `${run.name} failed` : `${run.name} finished`,
    body: failed && run.failedStep ? `Step ${run.failedStep.taskId} failed: ${run.failedStep.code}.` : "",
    link: `/runs/${run.executionId}`,
    userIds: await people([run.submittedBy]),
    teams: failed ? run.teams : [],
  });
}

/** Steps waiting for an approval: their teams' maintainers, and webhooks. */
export async function notifyApprovals(): Promise<number> {
  const all = await db.select({ id: teams.id, name: teams.name }).from(teams).where(and(isNull(teams.deletedAt), isNull(teams.retiredAt)));
  const waiting = await listAwaitingApproval(all.map((t) => t.name));
  let made = 0;
  for (const step of waiting) {
    const team = all.find((t) => t.name === step.team);
    if (!team) continue;
    const maintainers = await db
      .select({ id: teamMemberships.userId })
      .from(teamMemberships)
      .where(and(eq(teamMemberships.teamId, team.id), eq(teamMemberships.role, "maintainer")));
    const excluded = (await notDecidersOfRuns([step])).get(step.executionId) ?? [];
    const fresh = await notify({
      key: `approval:${step.executionId}:${step.taskId}:${step.awaitingSince ?? ""}`,
      kind: "approval_waiting",
      title: `${step.executionName}: ${step.taskId} needs ${team.name}'s approval`,
      body: `It runs ${step.action} and waits until a maintainer of ${team.name} approves or declines it.`,
      link: `/runs/${step.executionId}`,
      userIds: await people(maintainers.map((m) => m.id).filter((id) => !excluded.includes(id))),
      teams: [team.name],
    });
    if (fresh) made += 1;
  }
  return made;
}

/** The admins' chat channel: the team an admin chose, whose webhook also
 * gets admins' alerts (when it asks for their kinds); none while it's
 * retired or gone. */
export async function adminChannel(): Promise<string[]> {
  const [row] = await db
    .select({ name: teams.name })
    .from(notificationSettings)
    .innerJoin(teams, eq(teams.id, notificationSettings.adminTeamId))
    .where(and(eq(notificationSettings.id, 1), isNull(teams.deletedAt), isNull(teams.retiredAt)));
  return row ? [row.name] : [];
}

/** The install's admins who read an inbox. */
async function adminIds(): Promise<string[]> {
  const rows = await db.select({ id: users.id }).from(users).where(and(eq(users.isAdmin, true), eq(users.isBot, false)));
  return rows.map((r) => r.id);
}

/**
 * Steps the cluster refused in the last hour (the kernel's refusals: its
 * admission policies'): admins, whoever ran it, and its team's webhook, once
 * per step and reason.
 */
export async function notifyRefusals(): Promise<number> {
  const refused = await listRefusals(new Date(Date.now() - NEWS_MS));
  if (refused.length === 0) return 0;
  const runs = new Map((await findSubmittedExecutions([...new Set(refused.map((r) => r.executionId))])).map((e) => [e.executionId, e]));
  const admins = await adminIds();
  const channel = await adminChannel();
  let made = 0;
  for (const r of refused) {
    const fresh = await notify({
      key: `refused:${r.executionId}:${r.taskId}:${r.code}`,
      kind: "step_refused",
      title: `${r.team} step ${r.taskId} was refused: ${r.code}`,
      body: `${PLATFORM_ERRORS[r.code]?.means ?? r.message} Image: ${r.image}`,
      link: `/runs/${r.executionId}`,
      userIds: await people([...admins, runs.get(r.executionId)?.submittedBy ?? null]),
      teams: [r.team, ...channel],
    });
    if (fresh) made += 1;
  }
  return made;
}

/**
 * A platform change or fault: admins, once per `key`; `by`, whoever did it.
 * Never fails what it reports (a purge, a policy change), which is done and
 * audited already: an alert that can't be made is logged, and false.
 */
export async function platformAlert(key: string, title: string, body: string, by?: string, link = "/admin", log?: FastifyBaseLogger): Promise<boolean> {
  try {
    const [who] = by ? await db.select({ email: users.email }).from(users).where(eq(users.id, by)) : [];
    const said = who ? `${body}${body ? " " : ""}By ${who.email}.` : body;
    return await notify({ key: `platform:${key}`, kind: "platform_alert", title, body: said, link, userIds: await adminIds(), teams: await adminChannel() });
  } catch (error) {
    (log ?? console).error({ event: "platform_alert_failed", key, err: error }, "couldn't make a platform alert");
    return false;
  }
}

/** A policy the console keeps in the cluster failing to sync for a while. */
export async function notifyPolicySync(): Promise<number> {
  let made = 0;
  for (const [name, outcome] of Object.entries(policySyncOutcomes())) {
    if (!outcome || outcome.ok || !outcome.failingSince) continue;
    if (Date.now() - Date.parse(outcome.failingSince) < POLICY_GRACE_MS) continue;
    // Keyed by the day, not this console's failingSince: two consoles
    // seeing the same outage say it once.
    const fresh = await platformAlert(
      `policy:${name}:${new Date().toISOString().slice(0, 10)}`,
      `The ${name} isn't being synced to the cluster`,
      `Failing since ${outcome.failingSince}: ${(outcome.error ?? "").slice(0, 500)}`,
    );
    if (fresh) made += 1;
  }
  return made;
}

/**
 * The audit log's write-once copy (auditExport.ts): its chain broken, or an
 * entry differing from its copy, once each, at once (either means the log
 * was changed); and not copying for a while, once a day while it lasts.
 */
export async function notifyAuditCopy(): Promise<number> {
  const copy = await auditExportStatus();
  if (!copy) return 0;
  let made = 0;
  const link = "/admin/audit";
  if (copy.brokenAt) {
    const fresh = await platformAlert(
      `audit-broken:${String(copy.brokenAt)}`,
      "The audit log's chain is broken",
      `Entry ${String(copy.brokenAt)} doesn't follow the one before it, so the log was changed or entries removed. Nothing from there on is copied.`,
      undefined,
      link,
    );
    if (fresh) made += 1;
  }
  if (copy.differsAt) {
    const fresh = await platformAlert(
      `audit-differs:${String(copy.differsAt)}`,
      "An audit log entry differs from its write-once copy",
      copy.compareProblem ?? `Entry ${String(copy.differsAt)} was changed after it was copied.`,
      undefined,
      link,
    );
    if (fresh) made += 1;
  }
  // Not copying: since its last copy, for half an hour; never copied at all,
  // at once (checkedAt moves with every failed try, so it can't time that).
  const last = copy.exportedAt;
  if (copy.error && !copy.brokenAt && (!last || Date.now() - last.getTime() >= AUDIT_GRACE_MS)) {
    // Keyed by the day: two consoles seeing the same outage say it once.
    const fresh = await platformAlert(
      `audit-copying:${new Date().toISOString().slice(0, 10)}`,
      "The audit log isn't being copied",
      `${last ? `Nothing copied since ${last.toISOString()}` : "Nothing has been copied yet"}: ${copy.error.slice(0, 500)}`,
      undefined,
      link,
    );
    if (fresh) made += 1;
  }
  return made;
}

/** The catalog not pulled for a while: admins, once per outage. */
export async function notifyCatalog(): Promise<boolean> {
  const [status] = await db.select().from(catalogSync).where(eq(catalogSync.id, 1));
  if (!status?.error || !status.checkedAt) return false;
  const since = status.appliedAt ?? status.checkedAt;
  if (Date.now() - since.getTime() < CATALOG_GRACE_MS) return false;
  return notify({
    key: `catalog:${status.appliedAt?.toISOString() ?? "never"}`,
    kind: "catalog_failing",
    title: "The catalog isn't being pulled",
    body: status.error.slice(0, 500),
    link: "/admin",
    userIds: await adminIds(),
    teams: await adminChannel(),
  });
}

// --- posting to webhooks ---

/** Posts one message; throws why it couldn't. */
export async function postToWebhook(url: string, text: string): Promise<void> {
  const problem = webhookUrlProblem(url);
  if (problem) throw new Error(problem);
  // {"text": ...} is what Slack's, Google Chat's and Teams' incoming webhooks all take.
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`The webhook answered ${String(response.status)}.`);
}

function message(event: { title: string; body: string; link: string | null }): string {
  const link = event.link && config.consoleUrl ? `\n${config.consoleUrl}${event.link}` : "";
  return `${event.title}${event.body ? `\n${event.body}` : ""}${link}`;
}

/**
 * Constants no one else uses (callbacks.ts's is 4_170_225_613): one console
 * at a time makes each kind of delivery pass, so replicas don't post or
 * email the same one twice. Each is marked sent as soon as it went, so a
 * console that stops between sending and marking may still send it again
 * (at least once).
 */
const WEBHOOK_LOCK = 4_170_225_611;
const EMAIL_LOCK = 4_170_225_612;

/** Posts what's waiting to be posted, oldest first; 0 while another console is posting. */
export async function deliverWebhooks(log: FastifyBaseLogger): Promise<number> {
  return (await whileHolding(WEBHOOK_LOCK, () => postWaiting(log))) ?? 0;
}

async function postWaiting(log: FastifyBaseLogger): Promise<number> {
  const pending = await db
    .select({
      eventId: webhookDeliveries.eventId,
      teamId: webhookDeliveries.teamId,
      attempts: webhookDeliveries.attempts,
      title: notificationEvents.title,
      body: notificationEvents.body,
      link: notificationEvents.link,
      urlEncrypted: teamWebhooks.urlEncrypted,
    })
    .from(webhookDeliveries)
    .innerJoin(notificationEvents, eq(notificationEvents.id, webhookDeliveries.eventId))
    .innerJoin(teamWebhooks, eq(teamWebhooks.teamId, webhookDeliveries.teamId))
    .where(and(isNull(webhookDeliveries.sentAt), lt(webhookDeliveries.attempts, MAX_ATTEMPTS)))
    .orderBy(asc(notificationEvents.createdAt))
    .limit(50);
  let sent = 0;
  for (const d of pending) {
    const where = and(eq(webhookDeliveries.eventId, d.eventId), eq(webhookDeliveries.teamId, d.teamId));
    try {
      const url = decryptUrl(d.urlEncrypted);
      if (!url) throw new Error("The stored webhook URL can't be read (the console's key changed): set it again.");
      await postToWebhook(url, message(d));
      await db.update(webhookDeliveries).set({ sentAt: sql`now()`, attempts: d.attempts + 1 }).where(where);
      await db.update(teamWebhooks).set({ lastSentAt: sql`now()`, lastError: null }).where(eq(teamWebhooks.teamId, d.teamId));
      sent += 1;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      await db.update(webhookDeliveries).set({ attempts: d.attempts + 1 }).where(where);
      await db.update(teamWebhooks).set({ lastError: why.slice(0, 500) }).where(eq(teamWebhooks.teamId, d.teamId));
      log.warn({ event: "webhook_failed", teamId: d.teamId, err: why }, "couldn't post to a team's webhook");
    }
  }
  return sent;
}

// --- email ---

let transport: Transporter | undefined;

/** The SMTP connection, made once, with the password read from its file. */
async function mailer(): Promise<Transporter> {
  if (transport) return transport;
  const { host, port, tls, username, passwordFile } = config.notifications.email;
  const password = passwordFile ? (await readFile(passwordFile, "utf8")).trim() : "";
  transport = createTransport({
    host,
    port,
    secure: tls === "tls",
    requireTLS: tls === "starttls",
    ignoreTLS: tls === "none",
    ...(username ? { auth: { user: username, pass: password } } : {}),
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transport;
}

/** Emails what's waiting to be sent, oldest first; 0 while another console is sending. */
export async function deliverEmails(log: FastifyBaseLogger): Promise<number> {
  if (!config.notifications.email.host) return 0;
  return (await whileHolding(EMAIL_LOCK, () => sendWaiting(log))) ?? 0;
}

async function sendWaiting(log: FastifyBaseLogger): Promise<number> {
  const pending = await db
    .select({
      eventId: emailDeliveries.eventId,
      userId: emailDeliveries.userId,
      attempts: emailDeliveries.attempts,
      email: users.email,
      title: notificationEvents.title,
      body: notificationEvents.body,
      link: notificationEvents.link,
    })
    .from(emailDeliveries)
    .innerJoin(notificationEvents, eq(notificationEvents.id, emailDeliveries.eventId))
    .innerJoin(users, eq(users.id, emailDeliveries.userId))
    .where(and(isNull(emailDeliveries.sentAt), lt(emailDeliveries.attempts, MAX_ATTEMPTS)))
    .orderBy(asc(notificationEvents.createdAt))
    .limit(50);
  let sent = 0;
  for (const d of pending) {
    const where = and(eq(emailDeliveries.eventId, d.eventId), eq(emailDeliveries.userId, d.userId));
    try {
      await (await mailer()).sendMail({
        from: config.notifications.email.from,
        to: d.email,
        subject: d.title,
        text: `${message(d)}\n\nYou get these for your runs and your teams'. Choose which in Vertra: Preferences.`,
      });
      await db.update(emailDeliveries).set({ sentAt: sql`now()`, attempts: d.attempts + 1 }).where(where);
      sent += 1;
    } catch (error) {
      await db.update(emailDeliveries).set({ attempts: d.attempts + 1 }).where(where);
      log.warn({ event: "email_failed", userId: d.userId, err: error instanceof Error ? error.message : String(error) }, "couldn't send a notification email");
    }
  }
  return sent;
}

export function startNotifier(log: FastifyBaseLogger): void {
  let running = false;
  const pass = async () => {
    await notifyApprovals();
    await notifyCatalog();
    await notifyRefusals();
    await notifyPolicySync();
    await notifyAuditCopy();
    await deliverWebhooks(log);
    await deliverEmails(log);
    await deliverCallbacks(log);
  };
  const run = () => {
    if (running) return;
    running = true;
    pass()
      .catch((error: unknown) => {
        log.error({ err: error }, "couldn't look for what to notify");
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  setInterval(run, 30_000).unref();
}
