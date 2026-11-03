// SPDX-License-Identifier: MIT
/**
 * ScheduleService: a team's schedules, each a template or action run on a
 * cron, with set parameters, for the team, as one of its bots
 * (scheduleRunner.ts starts them). The team's members see them; its
 * maintainers (and admins) make, change and delete them. A schedule is
 * checked as its bot when it's made or changed (the bot may run it, the
 * parameters fit), and again on every run, so a bot that loses access
 * stops it there. At most one run every five minutes.
 */
import { Code } from "@connectrpc/connect";
import { asc, eq } from "drizzle-orm";
import { ApiError } from "../apiError.js";
import { ensureTeamMaintainer, ensureTeamMember } from "../auth/access.js";
import { callerForUser, type AuthUser } from "../auth/plugin.js";
import { knownTimeZone, nextRun, parseCron, shortestGapMinutes } from "../cron.js";
import { db } from "../db/client.js";
import { findTeamById, findTeamByName } from "../db/queries.js";
import { schedules, users } from "../db/schema.js";
import { ensureNotRetired } from "./retired.js";
import { ensureRunnable } from "./templates.js";

const MIN_GAP_MINUTES = 5;

type Schedule = typeof schedules.$inferSelect;

export interface ScheduleView extends Schedule {
  team: string;
  botEmail: string;
}

export interface ScheduleInput {
  name: string;
  kind: "template" | "action";
  runnableTeam: string;
  runnableName: string;
  parameters: Record<string, unknown>;
  cron: string;
  timeZone: string;
  botId: string;
  enabled: boolean;
}

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

async function teamNamed(name: string) {
  const team = await findTeamByName(name);
  if (!team) throw new ApiError(404, "NOT_FOUND", `No team "${name}".`);
  return team;
}

/** When it runs next from now, or why it can't run at all. */
export function nextFor(cron: string, timeZone: string, from = new Date()): Date | null {
  let parsed;
  try {
    parsed = parseCron(cron);
  } catch (error) {
    throw new ApiError(400, "BAD_SCHEDULE", error instanceof Error ? error.message : "That isn't a schedule.");
  }
  if (!knownTimeZone(timeZone)) throw new ApiError(400, "BAD_SCHEDULE", `"${timeZone}" isn't a time zone, such as Europe/Berlin or UTC.`);
  if (shortestGapMinutes(parsed, from, timeZone) < MIN_GAP_MINUTES) {
    throw new ApiError(400, "BAD_SCHEDULE", `A schedule runs at most every ${String(MIN_GAP_MINUTES)} minutes.`);
  }
  return nextRun(parsed, from, timeZone);
}

/** The bot it runs as: one of the team's bots, as a caller, which may run this with these parameters. */
async function checkedAsBot(team: string, input: ScheduleInput): Promise<void> {
  const [bot] = await db.select().from(users).where(eq(users.id, input.botId));
  const asBot = bot?.isBot ? await callerForUser(bot.id) : undefined;
  if (!asBot?.teamNames.includes(team)) throw new ApiError(400, "BAD_SCHEDULE", `A schedule runs as one of team "${team}"'s bots (its Automation tab).`);
  await ensureRunnable(asBot, input.kind, input.runnableTeam, input.runnableName, { parameters: input.parameters, onBehalfOf: team });
}

async function views(rows: Schedule[], team: string): Promise<ScheduleView[]> {
  const bots = new Map((await db.select({ id: users.id, email: users.email }).from(users)).map((u) => [u.id, u.email]));
  return rows.map((r) => ({ ...r, team, botEmail: bots.get(r.botId) ?? "" }));
}

export async function listSchedules(caller: AuthUser | undefined, teamName: string): Promise<ScheduleView[]> {
  const who = signedIn(caller);
  ensureTeamMember(who, teamName);
  const team = await teamNamed(teamName);
  return views(await db.select().from(schedules).where(eq(schedules.teamId, team.id)).orderBy(asc(schedules.name)), team.name);
}

export async function createSchedule(caller: AuthUser | undefined, teamName: string, input: ScheduleInput): Promise<ScheduleView> {
  const who = signedIn(caller);
  ensureTeamMaintainer(who, teamName);
  const team = await teamNamed(teamName);
  ensureNotRetired(team);
  const next = nextFor(input.cron, input.timeZone);
  await checkedAsBot(team.name, input);
  const [row] = await db
    .insert(schedules)
    .values({ ...input, teamId: team.id, createdBy: who.id, nextRunAt: input.enabled ? next : null })
    .onConflictDoNothing({ target: [schedules.teamId, schedules.name] })
    .returning();
  if (!row) throw new ApiError(409, "ALREADY_EXISTS", `Team "${team.name}" already has a schedule called "${input.name}".`, Code.AlreadyExists);
  return (await views([row], team.name))[0] as ScheduleView;
}

async function owned(who: AuthUser, id: string) {
  const [row] = await db.select().from(schedules).where(eq(schedules.id, id));
  const team = row ? await findTeamById(row.teamId) : undefined;
  if (!row || !team) throw new ApiError(404, "NOT_FOUND", "No such schedule.");
  ensureTeamMaintainer(who, team.name);
  return { row, team };
}

/** Changes a schedule: any of its fields; its next run follows. */
export async function updateSchedule(caller: AuthUser | undefined, id: string, change: Partial<ScheduleInput>): Promise<ScheduleView> {
  const who = signedIn(caller);
  const { row, team } = await owned(who, id);
  ensureNotRetired(team);
  const merged: ScheduleInput = {
    name: change.name ?? row.name,
    kind: change.kind ?? row.kind,
    runnableTeam: change.runnableTeam ?? row.runnableTeam,
    runnableName: change.runnableName ?? row.runnableName,
    parameters: change.parameters ?? row.parameters,
    cron: change.cron ?? row.cron,
    timeZone: change.timeZone ?? row.timeZone,
    botId: change.botId ?? row.botId,
    enabled: change.enabled ?? row.enabled,
  };
  const next = nextFor(merged.cron, merged.timeZone);
  if (merged.enabled) await checkedAsBot(team.name, merged);
  // A time claimed and not started (scheduleRunner.ts) is dropped when it's
  // paused or its timetable changes: resumed later, it'd start a stale time.
  const dropClaim = !merged.enabled || merged.cron !== row.cron || merged.timeZone !== row.timeZone;
  const [updated] = await db
    .update(schedules)
    .set({
      ...merged,
      updatedBy: who.id,
      nextRunAt: merged.enabled ? next : null,
      ...(merged.enabled && !row.enabled ? { lastError: null } : {}),
      ...(dropClaim ? { claimedRunAt: null, claimedAt: null } : {}),
    })
    .where(eq(schedules.id, id))
    .returning();
  return (await views(updated ? [updated] : [], team.name))[0] as ScheduleView;
}

export async function deleteSchedule(caller: AuthUser | undefined, id: string): Promise<void> {
  const who = signedIn(caller);
  await owned(who, id);
  await db.delete(schedules).where(eq(schedules.id, id));
}
