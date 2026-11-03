// SPDX-License-Identifier: MIT
/**
 * Cron expressions for schedules: the usual five fields (minute, hour, day
 * of the month, month, day of the week), each `*`, a number, a range `1-5`,
 * a list `1,15` or a step `*\/15`, `9-17/2`; days of the week 0-7 (0 and 7
 * are Sunday). As in cron, when both days are restricted, a time matching
 * either runs. Times are read in an IANA time zone ("Europe/Berlin"); a
 * minute that doesn't exist (clocks going forward) is skipped, one that
 * happens twice (going back) runs once, unless the minute or hour is `*` or
 * a step of it (as cron does: those run through the repeated hour).
 */

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
  /** Its minute or hour is `*` or `*\/n`: it runs through a repeated hour, as cron's do. */
  everyHour: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of the month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of the week", min: 0, max: 7 },
] as const;

function field(text: string, { name, min, max }: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`The ${name} "${part}" isn't a number, a range, a list or a step.`);
    const [, , from, to, step] = match;
    const start = from === undefined ? min : Number(from);
    const end = from === undefined ? max : to === undefined ? (step === undefined ? start : max) : Number(to);
    const by = step === undefined ? 1 : Number(step);
    if (start < min || end > max || start > end || by < 1) throw new Error(`The ${name} "${part}" is outside ${String(min)}-${String(max)}.`);
    for (let v = start; v <= end; v += by) out.add(v);
  }
  return out;
}

/** Reads a five-field cron expression, or throws why it can't. */
export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A schedule has five fields: minute, hour, day of the month, month, day of the week.");
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => field(p, FIELDS[i] ?? FIELDS[0]));
  if (!minutes || !hours || !days || !months || !weekdays) throw new Error("A schedule has five fields.");
  if (weekdays.has(7)) weekdays.add(0);
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    anyDay: parts[2] === "*",
    anyWeekday: parts[4] === "*",
    everyHour: Boolean(parts[0]?.startsWith("*") || parts[1]?.startsWith("*")),
  };
}

/** Whether a time zone is one this runtime knows. */
export function knownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** A moment's wall-clock parts in a time zone. */
function local(at: Date, timeZone: string) {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formats.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    month: Number(parts["month"]),
    day: Number(parts["day"]),
    hour: Number(parts["hour"]),
    minute: Number(parts["minute"]),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts["weekday"] ?? ""),
  };
}

function dayMatches(cron: Cron, t: ReturnType<typeof local>): boolean {
  if (!cron.months.has(t.month)) return false;
  const byDay = cron.days.has(t.day);
  const byWeekday = cron.weekdays.has(t.weekday);
  if (cron.anyDay && cron.anyWeekday) return true;
  if (cron.anyDay) return byWeekday;
  if (cron.anyWeekday) return byDay;
  return byDay || byWeekday;
}

const MINUTE = 60_000;

/**
 * Whether this wall-clock minute already happened (the clocks went back:
 * by an hour, or in a few zones half of one, or two): only its first time
 * runs.
 */
function repeated(at: Date, parts: ReturnType<typeof local>, timeZone: string): boolean {
  return [30, 60, 120].some((back) => {
    const earlier = local(new Date(at.getTime() - back * MINUTE), timeZone);
    return (
      earlier.month === parts.month &&
      earlier.day === parts.day &&
      earlier.hour === parts.hour &&
      earlier.minute === parts.minute
    );
  });
}

/** The first time after `after` that the schedule runs, within about five years; null if never. */
export function nextRun(cron: Cron, after: Date, timeZone: string): Date | null {
  let t = new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE);
  const limit = after.getTime() + 5 * 366 * 24 * 60 * MINUTE;
  while (t.getTime() < limit) {
    const parts = local(t, timeZone);
    if (!dayMatches(cron, parts)) {
      // Towards the next local midnight: the day's remaining minutes, less an
      // hour, so a day the clocks change can't carry it past midnight.
      // In its last hour, to the next hour: not a minute at a time.
      const towards = (23 - parts.hour) * 60 + (60 - parts.minute) - 60;
      t = new Date(t.getTime() + (towards >= 1 ? towards : 60 - parts.minute) * MINUTE);
      continue;
    }
    if (!cron.hours.has(parts.hour)) {
      t = new Date(t.getTime() + (60 - parts.minute) * MINUTE);
      continue;
    }
    if (cron.minutes.has(parts.minute) && (cron.everyHour || !repeated(t, parts, timeZone))) return t;
    t = new Date(t.getTime() + MINUTE);
  }
  return null;
}

/** The shortest time between its runs, over the next few: for refusing ones too frequent. */
export function shortestGapMinutes(cron: Cron, from: Date, timeZone: string): number {
  let shortest = Infinity;
  let previous = nextRun(cron, from, timeZone);
  for (let i = 0; i < 24 && previous; i++) {
    const following = nextRun(cron, previous, timeZone);
    if (!following) break;
    shortest = Math.min(shortest, (following.getTime() - previous.getTime()) / MINUTE);
    previous = following;
  }
  return shortest;
}
