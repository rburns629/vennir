// SPDX-License-Identifier: MIT
/** Cron expressions for schedules (src/cron.ts): fields, time zones, either day, and refusals. */
import { describe, expect, it } from "vitest";
import { knownTimeZone, nextRun, parseCron, shortestGapMinutes } from "../src/cron.js";

const at = (iso: string) => new Date(iso);

describe("a schedule's next run", () => {
  it("is the next matching minute, in UTC", () => {
    expect(nextRun(parseCron("*/15 * * * *"), at("2026-10-24T10:07:30Z"), "UTC")?.toISOString()).toBe("2026-10-24T10:15:00.000Z");
    expect(nextRun(parseCron("0 9 * * 1-5"), at("2026-10-24T10:00:00Z"), "UTC")?.toISOString()).toBe("2026-10-26T09:00:00.000Z"); // a Saturday, so Monday
    expect(nextRun(parseCron("30 2 1 1 *"), at("2026-10-24T10:00:00Z"), "UTC")?.toISOString()).toBe("2027-01-01T02:30:00.000Z");
  });

  it("is read in its time zone, across a change of the clocks", () => {
    // 09:00 in Berlin: UTC+2 in summer time, UTC+1 after 25 October 2026.
    expect(nextRun(parseCron("0 9 * * *"), at("2026-10-24T08:00:00Z"), "Europe/Berlin")?.toISOString()).toBe("2026-10-25T08:00:00.000Z");
    expect(nextRun(parseCron("0 9 * * *"), at("2026-10-25T09:00:00Z"), "Europe/Berlin")?.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  it("doesn't skip the midnight after the clocks change", () => {
    // 25 October in Berlin is 25 hours long; midnight on the 26th still runs.
    expect(nextRun(parseCron("0 0 * * *"), at("2026-10-25T08:00:00Z"), "Europe/Berlin")?.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    // 29 March 2026 is 23 hours long.
    expect(nextRun(parseCron("0 0 * * *"), at("2026-03-29T08:00:00Z"), "Europe/Berlin")?.toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("runs a minute the clocks repeat once, the first time", () => {
    // 1 November 2026 in New York: 01:00-01:59 happens in EDT, then again in EST.
    const nightly = parseCron("30 1 * * *");
    const first = nextRun(nightly, at("2026-11-01T04:00:00Z"), "America/New_York");
    expect(first?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(nextRun(nightly, first!, "America/New_York")?.toISOString()).toBe("2026-11-02T06:30:00.000Z");
    // Berlin, 25 October 2026: 02:00-02:59 twice.
    const berlin = nextRun(parseCron("30 2 * * *"), at("2026-10-24T12:00:00Z"), "Europe/Berlin");
    expect(berlin?.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(nextRun(parseCron("30 2 * * *"), berlin!, "Europe/Berlin")?.toISOString()).toBe("2026-10-26T01:30:00.000Z");
    // Lord Howe goes back half an hour (02:00 to 01:30 on 5 April 2026).
    const howe = nextRun(parseCron("45 1 * * *"), at("2026-04-04T12:00:00Z"), "Australia/Lord_Howe");
    expect(nextRun(parseCron("45 1 * * *"), howe!, "Australia/Lord_Howe")!.getTime() - howe!.getTime()).toBeGreaterThan(23 * 3_600_000);
    // Every 15 minutes still runs through the repeated hour's new minutes only.
    expect(nextRun(parseCron("*/15 * * * *"), at("2026-11-01T05:50:00Z"), "America/New_York")?.toISOString()).toBe("2026-11-01T07:00:00.000Z");
  });

  it("runs on either day when both are restricted, as cron does", () => {
    // The 1st, or a Monday: after Saturday 24 October, Monday the 26th comes first.
    expect(nextRun(parseCron("0 0 1 * 1"), at("2026-10-24T00:00:00Z"), "UTC")?.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(nextRun(parseCron("0 0 * * 7"), at("2026-10-24T00:00:00Z"), "UTC")?.toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });

  it("says what's wrong with an expression, a time zone, or never", () => {
    expect(() => parseCron("* * * *")).toThrow(/five fields/);
    expect(() => parseCron("61 * * * *")).toThrow(/minute "61" is outside 0-59/);
    expect(() => parseCron("* * * * mon")).toThrow(/day of the week "mon"/);
    expect(knownTimeZone("Europe/Berlin")).toBe(true);
    expect(knownTimeZone("Mars/Olympus")).toBe(false);
    expect(nextRun(parseCron("0 0 31 2 *"), at("2026-10-24T00:00:00Z"), "UTC")).toBeNull();
  });

  it("knows how often it runs", () => {
    expect(shortestGapMinutes(parseCron("*/5 * * * *"), at("2026-10-24T00:00:00Z"), "UTC")).toBe(5);
    expect(shortestGapMinutes(parseCron("0,1 * * * *"), at("2026-10-24T00:00:00Z"), "UTC")).toBe(1);
  });
});
