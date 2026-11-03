// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { inZone, scheduleTimes, zoneName } from "./time";

const WINTER = new Date("2026-11-03T07:00:00Z");

describe("a schedule's times", () => {
  it("name a zone by its city, whatever its case", () => {
    expect(zoneName("America/New_York", WINTER)).toBe("New York");
    expect(zoneName("america/new_york", WINTER)).toBe("New York");
    expect(zoneName("America/Argentina/Buenos_Aires", WINTER)).toBe("Buenos Aires");
    // Not the older name a browser may know it by (Asia/Calcutta).
    expect(zoneName("Asia/Kolkata", WINTER)).toBe("Kolkata");
  });

  it("name UTC as UTC, in any of its spellings", () => {
    for (const zone of ["UTC", "utc", "Etc/UTC", "Etc/GMT", "GMT", "GMT0", "Zulu"]) expect(zoneName(zone, WINTER)).toBe("UTC");
  });

  it("name a zone with no city by its offset then", () => {
    // Etc/GMT+5 is five hours behind: POSIX's sign.
    expect(zoneName("Etc/GMT+5", WINTER)).toBe("GMT-5");
    expect(zoneName("EST", WINTER)).toBe("GMT-5");
    expect(zoneName("US/Eastern", WINTER)).toBe("GMT-5");
    expect(zoneName("+05:30", WINTER)).toBe("GMT+5:30");
  });

  it("know when a zone isn't one", () => {
    expect(zoneName("Mars/Olympus_Mons", WINTER)).toBeNull();
  });

  it("are the schedule's own, with the viewer's beside them", () => {
    // 07:00 in London on Nov 3 is 02:00 in New York.
    expect(scheduleTimes("2026-11-03T07:00:00Z", "America/New_York", "Europe/London")).toEqual({ own: "02:00 New York time", yours: "07:00 your time (London)" });
    expect(scheduleTimes("2026-11-03T07:00:00Z", "UTC", "Europe/Berlin").own).toBe("07:00 UTC");
    expect(scheduleTimes("2026-11-03T07:00:00Z", "Etc/GMT+5", "Europe/London").own).toBe("02:00 GMT-5");
    // A zone the browser doesn't know: the viewer's time, said to be theirs.
    expect(scheduleTimes("2026-11-03T07:00:00Z", "Mars/Olympus_Mons", "Europe/London").own).toBe("07:00 your time (London)");
  });

  it("put the day in the schedule's zone, not the viewer's", () => {
    // 03:30 on Sunday in Berlin is still 22:30 on Saturday in New York.
    const at = inZone("2026-11-01T02:30:00Z", "America/New_York");
    expect(at.date).toBe("31");
    expect(at.time).toBe("22:30");
    expect(at.day).toBe("Sat");
    expect(inZone("2026-11-01T02:30:00Z", "Europe/Berlin").date).toBe("1");
  });
});
