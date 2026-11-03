// SPDX-License-Identifier: MIT
/**
 * Callbacks for systems (decision 23): when a run finishes (succeeded,
 * failed or cancelled), its outcome is posted as JSON to
 *
 *   - the ordering bot's callback, when a bot with one placed it (an order:
 *     `order.finished`, small: which order, which run, how it ended; its
 *     outputs are read with GetExecution, as the bot), so the system that
 *     placed it (a storefront, a Marketplace page) hears back without
 *     polling;
 *   - each owning team's outcome webhook, when it has one (`run.finished`:
 *     the run and each step's state, outputs and failure code, as the team
 *     sees them on its run's page), for its own systems, beside its chat
 *     webhook.
 *
 * Each post is signed with its callback's secret (shown once, when it's
 * set): `Vertra-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
 * "<t>.<body>">`, so a receiver checks it came from this install and isn't
 * an old one replayed. Like a team's chat webhook, the URL is sealed, only
 * under the install's allowed hosts (config.orders.callbackHosts), never
 * redirected, and posted up to five times, every 30 seconds (notifier.ts's
 * pass).
 */
import type { FastifyBaseLogger } from "fastify";
import { createHmac, randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { ApiError } from "./apiError.js";
import { config } from "./config.js";
import { backendAllowed } from "./core/apis.js";
import { db, whileHolding } from "./db/client.js";
import { botCallbacks, callbackDeliveries, teamCallbacks, teams } from "./db/schema.js";
import type { KernelTaskStatus } from "./kernel/client.js";
import { seal, unseal } from "./sealed.js";

const MAX_ATTEMPTS = 5;
/** A run finished longer ago than this when it's recorded isn't news. */
const NEWS_MS = 60 * 60_000;
/** A team's post with every step's outputs larger than this goes without them. */
const MAX_BODY = 256 * 1024;
const URLS = "order callback urls";
const SECRETS = "order callback secrets";

/** Why a callback URL can't be used, or null. */
export function callbackUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That isn't a URL.";
  }
  if (parsed.protocol !== "https:") return "A callback URL starts with https://.";
  if (parsed.username || parsed.password) return "A callback URL has no user name or password in it.";
  const hosts = config.orders.callbackHosts;
  if (hosts.length === 0) return "This install allows no callbacks (the console chart's orders.callbackHosts).";
  if (!backendAllowed(url, hosts)) return `Callbacks may only go to ${hosts.join(", ")} (the install's orders.callbackHosts).`;
  return null;
}

/**
 * A callback's stored fields for a URL, keeping the secret it has (when it
 * can still be read) unless asked for a new one; refuses (BAD_CALLBACK) a
 * URL that can't be used. `signingSecret` is set only when the secret is new.
 */
export function newCallback(
  url: string,
  rotateSecret: boolean,
  existingSecret: string | undefined,
): { urlEncrypted: string; host: string; secretEncrypted: string; signingSecret: string } {
  const problem = callbackUrlProblem(url);
  if (problem) throw new ApiError(400, "BAD_CALLBACK", problem);
  const kept = existingSecret !== undefined && !rotateSecret ? unseal(existingSecret, SECRETS) : null;
  const secret = kept ?? `vcs_${randomBytes(32).toString("base64url")}`;
  return {
    urlEncrypted: seal(url, URLS),
    host: new URL(url).host,
    secretEncrypted: seal(secret, SECRETS),
    signingSecret: kept ? "" : secret,
  };
}

/** The Vertra-Signature header for a body, at a time (unix seconds). */
export function signature(secret: string, body: string, at: number): string {
  return `t=${String(at)},v1=${createHmac("sha256", secret).update(`${String(at)}.${body}`).digest("hex")}`;
}

export interface FinishedRun {
  executionId: string;
  name: string;
  submittedBy: string | null;
  teams: string[];
  template: string | null;
  onBehalfOf: string | null;
  payload: unknown;
  state: string;
  finishedAt: string | null;
  tasks: KernelTaskStatus[];
}

/** Queues a finished run's outcome for its bot's callback and its teams' outcome webhooks, once per finish. */
export async function runFinishedCallbacks(run: FinishedRun): Promise<void> {
  if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(run.state)) return;
  const at = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
  if (!Number.isFinite(at) || Date.now() - at > NEWS_MS) return;
  const finish = `${run.executionId}:${run.state}:${run.finishedAt ?? ""}`;
  const requestId = (run.payload as { requestId?: unknown } | null)?.requestId;
  const common = {
    executionId: run.executionId,
    requestId: typeof requestId === "string" ? requestId : null,
    template: run.template,
  };

  // An order: its bot's callback, if it has one (insert-from-select, so none is a no-op).
  if (run.submittedBy && run.template) {
    const body = JSON.stringify({ type: "order.finished", ...common, onBehalfOf: run.onBehalfOf, state: run.state, finishedAt: run.finishedAt });
    await db
      .insert(callbackDeliveries)
      .select(
        db
          .select({
            key: sql<string>`${finish}::text`.as("key"),
            botId: botCallbacks.botId,
            teamId: sql<null>`null::uuid`.as("team_id"),
            body: sql<string>`${body}::text`.as("body"),
            attempts: sql<number>`0`.as("attempts"),
            sentAt: sql<null>`null::timestamptz`.as("sent_at"),
            createdAt: sql<Date>`now()`.as("created_at"),
          })
          .from(botCallbacks)
          .where(eq(botCallbacks.botId, run.submittedBy)),
      )
      .onConflictDoNothing();
  }

  // Its owning teams' outcome webhooks: those who see it in full (core/runView.ts).
  const owners = run.template !== null ? (run.onBehalfOf ? [run.onBehalfOf] : []) : run.teams;
  if (owners.length === 0) return;
  const hooked = await db
    .select({ teamId: teamCallbacks.teamId, team: teams.name })
    .from(teamCallbacks)
    .innerJoin(teams, eq(teams.id, teamCallbacks.teamId))
    .where(inArray(teams.name, owners));
  if (hooked.length === 0) return;
  const steps = run.tasks.map((t) => ({
    taskId: t.taskId,
    state: t.state,
    outputs: t.outputs,
    failureCode: typeof t.failure?.["code"] === "string" ? t.failure["code"] : null,
  }));
  for (const { teamId, team } of hooked) {
    const full = { type: "run.finished", ...common, name: run.name, team, state: run.state, finishedAt: run.finishedAt, steps };
    let body = JSON.stringify(full);
    if (Buffer.byteLength(body) > MAX_BODY) {
      body = JSON.stringify({ ...full, steps: steps.map((s) => ({ ...s, outputs: null })), outputsOmitted: true });
    }
    await db.insert(callbackDeliveries).values({ key: `${finish}:team:${teamId}`, teamId, body }).onConflictDoNothing();
  }
}

/** Posts one signed body; throws why it couldn't. */
export async function postCallback(url: string, secret: string, body: string): Promise<void> {
  const problem = callbackUrlProblem(url);
  if (problem) throw new Error(problem);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "vertra-signature": signature(secret, body, Math.floor(Date.now() / 1000)) },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`The callback answered ${String(response.status)}.`);
}

/**
 * A constant no one else uses: one console at a time posts callbacks, so
 * replicas don't post the same one twice. Each is marked sent as soon as it
 * went, so a console that stops between posting and marking may still post
 * it again (at least once).
 */
const DELIVERY_LOCK = 4_170_225_613;

/** Posts what's waiting to be posted, oldest first; 0 while another console is posting. */
export async function deliverCallbacks(log: FastifyBaseLogger): Promise<number> {
  return (await whileHolding(DELIVERY_LOCK, () => postWaiting(log))) ?? 0;
}

async function postWaiting(log: FastifyBaseLogger): Promise<number> {
  const pending = await db
    .select({
      key: callbackDeliveries.key,
      botId: callbackDeliveries.botId,
      teamId: callbackDeliveries.teamId,
      attempts: callbackDeliveries.attempts,
      body: callbackDeliveries.body,
      botUrl: botCallbacks.urlEncrypted,
      botSecret: botCallbacks.secretEncrypted,
      teamUrl: teamCallbacks.urlEncrypted,
      teamSecret: teamCallbacks.secretEncrypted,
    })
    .from(callbackDeliveries)
    .leftJoin(botCallbacks, eq(botCallbacks.botId, callbackDeliveries.botId))
    .leftJoin(teamCallbacks, eq(teamCallbacks.teamId, callbackDeliveries.teamId))
    .where(
      and(
        isNull(callbackDeliveries.sentAt),
        lt(callbackDeliveries.attempts, MAX_ATTEMPTS),
        // Its callback is still there (one removed since has nothing to post to).
        or(isNotNull(botCallbacks.botId), isNotNull(teamCallbacks.teamId)),
      ),
    )
    .orderBy(asc(callbackDeliveries.createdAt))
    .limit(50);
  let sent = 0;
  for (const d of pending) {
    const stored = d.botId ? { url: d.botUrl ?? "", secret: d.botSecret ?? "" } : { url: d.teamUrl ?? "", secret: d.teamSecret ?? "" };
    const where = eq(callbackDeliveries.key, d.key);
    const mark = async (fields: { lastSentAt?: SQL; lastError: string | null }) => {
      if (d.botId) await db.update(botCallbacks).set(fields).where(eq(botCallbacks.botId, d.botId));
      else if (d.teamId) await db.update(teamCallbacks).set(fields).where(eq(teamCallbacks.teamId, d.teamId));
    };
    try {
      const url = unseal(stored.url, URLS);
      const secret = unseal(stored.secret, SECRETS);
      if (!url || !secret) throw new Error("The stored callback can't be read (the console's key changed): set it again.");
      await postCallback(url, secret, d.body);
      await db.update(callbackDeliveries).set({ sentAt: sql`now()`, attempts: d.attempts + 1 }).where(where);
      await mark({ lastSentAt: sql`now()`, lastError: null });
      sent += 1;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      await db.update(callbackDeliveries).set({ attempts: d.attempts + 1 }).where(where);
      await mark({ lastError: why.slice(0, 500) });
      log.warn({ event: "callback_failed", botId: d.botId, teamId: d.teamId, err: why }, "couldn't post to a callback");
    }
  }
  return sent;
}
