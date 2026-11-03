// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";

/** A span of time as people say it: "14s", "8m 05s", "2h 03m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60).padStart(2, "0")}m`;
}

/** When something happened, relative to today: "today 14:02", "yesterday 16:20", "Oct 12 09:15". */
export function when(iso: string): string {
  const at = new Date(iso);
  const today = new Date();
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === today.toDateString()) return `today ${time}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** The time now, ticking every second while `live`: for durations still running. */
export function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [live]);
  return now;
}

/** The IANA areas whose zones are named for a city ("America/New_York"). */
const CITY_AREAS = /^(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\//;

/** The zone's own name, its case as IANA spells it ("america/new_york" is "America/New_York"); null if the browser doesn't know it. */
function knownZone(timeZone: string): string | null {
  try {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
    // A link the browser renames (Asia/Kolkata to Asia/Calcutta) keeps the name given.
    return canonical.toLowerCase() === timeZone.toLowerCase() ? canonical : timeZone;
  } catch {
    return null;
  }
}

/**
 * A time zone as people name it: its city ("America/New_York" is "New
 * York"), else its offset at that moment ("Etc/GMT+5" is "GMT-5", "EST"
 * is "GMT-5", "+05:30" is "GMT+5:30"), or "UTC". Null for a zone the
 * browser doesn't know.
 */
export function zoneName(timeZone: string, at: Date = new Date()): string | null {
  const zone = knownZone(timeZone);
  if (!zone) return null;
  if (CITY_AREAS.test(zone)) return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  return /^GMT([+-]0(:00)?)?$/.test(offset) || !offset ? "UTC" : offset;
}

/** The viewer's own time zone. */
export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * A moment as it is in a time zone: its day ("Fri"), date ("31") and time
 * ("02:00"), each from its own part so no locale adds to them. A zone the
 * browser doesn't know is shown as the viewer's.
 */
export function inZone(iso: string, timeZone: string): { day: string; date: string; time: string } {
  const options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  const zone = knownZone(timeZone);
  const parts = new Intl.DateTimeFormat([], zone ? { ...options, timeZone: zone } : options).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: part("weekday"), date: part("day"), time: `${part("hour")}:${part("minute")}` };
}

/** A schedule's next run in its own zone ("02:00 New York time", "02:00 GMT-5"), and in the viewer's ("07:00 your time (London)"). */
export function scheduleTimes(iso: string, timeZone: string, viewer = localZone()): { own: string; yours: string } {
  const at = new Date(iso);
  const mine = zoneName(viewer, at);
  const yours = `${inZone(iso, viewer).time} your time${mine ? ` (${mine})` : ""}`;
  const name = zoneName(timeZone, at);
  // A zone the browser doesn't know: say the viewer's time as theirs, not under the schedule's name.
  if (!name) return { own: yours, yours };
  return { own: `${inZone(iso, timeZone).time} ${/^(UTC|GMT)/.test(name) ? name : `${name} time`}`, yours };
}
