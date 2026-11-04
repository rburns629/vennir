// SPDX-License-Identifier: MIT
/**
 * Starting schedules (core/schedules.ts): every 30 seconds, each enabled
 * schedule whose time has come is claimed by moving its next run on, in
 * one conditional write (so two consoles never start it twice, and a
 * console that was down starts only the latest time it missed), then run
 * as its bot, for its team, as the bot running it itself would be, with a
 * request id per time so a retried start doesn't run it twice. The claim
 * records the time until it's started, so a time a console claimed and
 * then stopped before starting (a rollout, say) is started by another
 * after CLAIM_MINUTES. A start that's refused (the bot lost access, a
 * parameter no longer fits), or a schedule that can't run again (its cron
 * or time zone no longer reads), is kept on the schedule and told to the
 * team's maintainers.
 */
import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNotNull, lt, lte, sql } from "drizzle-orm";
import { ApiError } from "./apiError.js";
import { callerForUser } from "./auth/plugin.js";
import { nextFor } from "./core/schedules.js";
import { runAction, runTemplate } from "./core/templates.js";
import { db } from "./db/client.js";
import { schedules, teamMemberships, teams, users } from "./db/schema.js";
import { config } from "./config.js";
import { recordNextSchedule } from "./k8s.js";
import { notify } from "./notifier.js";

type Schedule = typeof schedules.$inferSelect;

/** How long a claimed time may wait to be started before another console starts it. */
export const CLAIM_MINUTES = 5;

/**
 * Claims a due schedule by moving its next run on, recording the time
 * claimed; returns that time, or null if another console got it, and why it
 * won't run again when its next time can't be worked out.
 */
async function claim(schedule: Schedule): Promise<{ due: Date; stopped?: string } | null> {
  if (!schedule.nextRunAt) return null;
  let next: Date | null;
  let stopped: string | undefined;
  try {
    next = nextFor(schedule.cron, schedule.timeZone);
  } catch (error) {
    next = null;
    stopped = error instanceof ApiError ? error.message : String(error);
  }
  const [claimed] = await db
    .update(schedules)
    .set({ nextRunAt: next, claimedRunAt: schedule.nextRunAt, claimedAt: new Date() })
    .where(and(eq(schedules.id, schedule.id), eq(schedules.nextRunAt, schedule.nextRunAt)))
    .returning({ id: schedules.id });
  if (!claimed) return null;
  return stopped === undefined ? { due: schedule.nextRunAt } : { due: schedule.nextRunAt, stopped };
}

/** Takes over a time another console claimed CLAIM_MINUTES ago and didn't start; returns it, or null if one already did. */
async function reclaim(schedule: Schedule): Promise<Date | null> {
  if (!schedule.claimedRunAt || !schedule.claimedAt) return null;
  const [claimed] = await db
    .update(schedules)
    .set({ claimedAt: new Date() })
    .where(and(eq(schedules.id, schedule.id), eq(schedules.claimedAt, schedule.claimedAt)))
    .returning({ id: schedules.id });
  return claimed ? schedule.claimedRunAt : null;
}

async function tellMaintainers(schedule: Schedule, team: string, key: string, title: string, why: string): Promise<void> {
  const maintainers = await db
    .select({ id: teamMemberships.userId })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(and(eq(teamMemberships.teamId, schedule.teamId), eq(teamMemberships.role, "maintainer"), eq(users.isBot, false)));
  await notify({
    key,
    kind: "run_failed",
    title,
    body: why.slice(0, 500),
    link: `/teams/${team}?tab=schedules`,
    userIds: maintainers.map((m) => m.id),
    teams: [team],
  });
}

/** Starts one schedule's run, due at `due`, and clears that time's claim. */
async function start(schedule: Schedule, team: string, due: Date, log: FastifyBaseLogger): Promise<void> {
  const request = { parameters: schedule.parameters, onBehalfOf: team, requestId: `schedule:${schedule.id}:${due.toISOString()}` };
  try {
    const bot = await callerForUser(schedule.botId);
    if (!bot) throw new ApiError(409, "BOT_GONE", "Its bot no longer exists.");
    const run =
      schedule.kind === "template"
        ? await runTemplate(bot, schedule.runnableTeam, schedule.runnableName, request, log, schedule.id)
        : await runAction(bot, schedule.runnableName, request, log, schedule.id);
    await db.update(schedules).set({ lastRunAt: due, lastExecutionId: run.executionId, lastError: null }).where(eq(schedules.id, schedule.id));
    log.info({ event: "schedule_started", scheduleId: schedule.id, executionId: run.executionId }, "started a scheduled run");
  } catch (error) {
    // Refused (an ApiError says why), or the platform didn't answer: this
    // time is missed either way, and the schedule says so.
    const why = error instanceof ApiError ? error.message : "Vennir couldn't start it: the platform didn't answer. The next time runs as usual.";
    await db.update(schedules).set({ lastRunAt: due, lastError: why.slice(0, 1000) }).where(eq(schedules.id, schedule.id));
    log.warn({ event: "schedule_refused", scheduleId: schedule.id, err: error }, "a scheduled run didn't start");
    await tellMaintainers(schedule, team, `schedule:${schedule.id}:${due.toISOString()}`, `Schedule ${schedule.name} couldn't start`, why);
  }
  // Unless a later time has been claimed since.
  await db
    .update(schedules)
    .set({ claimedRunAt: null, claimedAt: null })
    .where(and(eq(schedules.id, schedule.id), eq(schedules.claimedRunAt, due)));
}

let nextRecorded: string | undefined;

/**
 * The earliest enabled schedule's next run, kept in the activity ConfigMap
 * for the kernel's sleeper: it stays awake for one due soon, and wakes a
 * sleeping install a little before one. Written only when it changes.
 */
async function publishNextSchedule(): Promise<void> {
  if (!config.activityConfigMap || !config.platformNamespace) return;
  const [row] = await db
    .select({ next: sql<Date | null>`min(${schedules.nextRunAt})` })
    .from(schedules)
    .where(and(eq(schedules.enabled, true), isNotNull(schedules.nextRunAt)));
  const next = row?.next ? new Date(row.next) : null;
  const key = next?.toISOString() ?? "";
  if (key === nextRecorded) return;
  await recordNextSchedule(config.platformNamespace, config.activityConfigMap, next);
  nextRecorded = key;
}

/** A schedule whose next time can't be worked out: it's started this once, then says why it won't run again. */
async function stop(schedule: Schedule, team: string, due: Date, why: string, log: FastifyBaseLogger): Promise<void> {
  const error = `It won't run again: ${why} Change its schedule to start it again.`;
  await db.update(schedules).set({ lastError: error.slice(0, 1000) }).where(eq(schedules.id, schedule.id));
  log.warn({ event: "schedule_stopped", scheduleId: schedule.id, reason: why }, "a schedule can't run again");
  await tellMaintainers(schedule, team, `schedule:${schedule.id}:${due.toISOString()}:stopped`, `Schedule ${schedule.name} won't run again`, error);
}

/** One pass: every enabled schedule that's due, and every time claimed but not started. */
export async function startDueSchedules(log: FastifyBaseLogger): Promise<number> {
  const unstarted = await db
    .select({ schedule: schedules, team: teams.name })
    .from(schedules)
    .innerJoin(teams, eq(teams.id, schedules.teamId))
    .where(
      and(
        eq(schedules.enabled, true),
        isNotNull(schedules.claimedRunAt),
        lt(schedules.claimedAt, sql`now() - make_interval(mins => ${CLAIM_MINUTES})`),
      ),
    )
    .limit(50);
  let started = 0;
  for (const { schedule, team } of unstarted) {
    const at = await reclaim(schedule);
    if (!at) continue;
    log.warn({ event: "schedule_claim_resumed", scheduleId: schedule.id, due: at.toISOString() }, "starting a scheduled time another console claimed and didn't start");
    await start(schedule, team, at, log);
    started += 1;
  }
  const due = await db
    .select({ schedule: schedules, team: teams.name })
    .from(schedules)
    .innerJoin(teams, eq(teams.id, schedules.teamId))
    .where(and(eq(schedules.enabled, true), isNotNull(schedules.nextRunAt), lte(schedules.nextRunAt, sql`now()`)))
    .limit(50);
  for (const { schedule, team } of due) {
    const claimed = await claim(schedule);
    if (!claimed) continue;
    await start(schedule, team, claimed.due, log);
    if (claimed.stopped !== undefined) await stop(schedule, team, claimed.due, claimed.stopped, log);
    started += 1;
  }
  await publishNextSchedule();
  return started;
}

export function startScheduleRunner(log: FastifyBaseLogger): void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    startDueSchedules(log)
      .catch((error: unknown) => {
        log.error({ err: error }, "couldn't start due schedules");
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  setInterval(run, 30_000).unref();
}
