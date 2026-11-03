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

/** A time zone as people name it: its city ("America/New_York" is "New York"), or "UTC". */
export function zoneName(timeZone: string): string {
  if (/^(Etc\/)?(UTC|GMT|Zulu|UCT|Universal)$/.test(timeZone)) return "UTC";
  return (timeZone.split("/").pop() ?? timeZone).replace(/_/g, " ");
}

/** The viewer's own time zone. */
export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * A moment as it is in a time zone: its day ("Fri"), date ("31") and time
 * ("02:00"). A zone the browser doesn't know is shown as the viewer's.
 */
export function inZone(iso: string, timeZone: string): { day: string; date: string; time: string } {
  const at = new Date(iso);
  const part = (options: Intl.DateTimeFormatOptions) => {
    try {
      return at.toLocaleString([], { ...options, timeZone });
    } catch {
      return at.toLocaleString([], options);
    }
  };
  return { day: part({ weekday: "short" }), date: part({ day: "numeric" }), time: part({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) };
}

/** A schedule's next run in its own zone ("02:00 New York time"), and in the viewer's ("07:00 your time (London)"). */
export function scheduleTimes(iso: string, timeZone: string, viewer = localZone()): { own: string; yours: string } {
  const name = zoneName(timeZone);
  return {
    own: `${inZone(iso, timeZone).time} ${name === "UTC" ? "UTC" : `${name} time`}`,
    yours: `${inZone(iso, viewer).time} your time (${zoneName(viewer)})`,
  };
}
