// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { inZone, scheduleTimes, zoneName } from "./time";

describe("a schedule's times", () => {
  it("name a zone by its city, or UTC", () => {
    expect(zoneName("America/New_York")).toBe("New York");
    expect(zoneName("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(zoneName("UTC")).toBe("UTC");
    expect(zoneName("Etc/UTC")).toBe("UTC");
  });

  it("are the schedule's own, with the viewer's beside them", () => {
    // 07:00 in London on Nov 3 is 02:00 in New York.
    expect(scheduleTimes("2026-11-03T07:00:00Z", "America/New_York", "Europe/London")).toEqual({ own: "02:00 New York time", yours: "07:00 your time (London)" });
    expect(scheduleTimes("2026-11-03T07:00:00Z", "UTC", "Europe/Berlin").own).toBe("07:00 UTC");
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
