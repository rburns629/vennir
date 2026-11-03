// SPDX-License-Identifier: MIT
/**
 * Settings are checked when the console starts (config.ts): a setting
 * that's wrong stops it, naming the setting, rather than doing something
 * else. A negative retention was taken as "every row older than the
 * future", and deleted the whole audit log.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const load = async (env: Record<string, string>) => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return import("../src/config.js");
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("settings", () => {
  it("refuse a negative, fractional or non-numeric number, naming it", async () => {
    for (const [name, value] of [
      ["AUDIT_RETENTION_DAYS", "-1"],
      ["EXECUTION_RETENTION_DAYS", "1.5"],
      ["SCAN_RETENTION_DAYS", "forever"],
      ["POLICY_SYNC_INTERVAL_SECONDS", "0"],
      ["AUDIT_EXPORT_MINUTES", "-5"],
      ["LOG_SEARCH_DAYS", "x"],
      ["SCAN_RESCAN_HOURS", "0"],
      ["PORT", "70000"],
      ["SMTP_PORT", "0"],
      ["AUDIT_EXPORT_PROVIDER", "azure"],
      ["DATABASE_POOL_SIZE", "1"], // a background pass's lock takes one of them
      ["SCAN_PLATFORMS", "linux/amd64,arm64"],
    ] as const) {
      await expect(load({ [name]: value }), name).rejects.toThrow(name);
    }
  });

  it("take 0 where 0 means forever, none or off", async () => {
    const { config } = await load({ AUDIT_RETENTION_DAYS: "0", SCANNER_IDLE_MINUTES: "0", SCAN_WAIT_SECONDS: "0", METRICS_PORT: "0" });
    expect(config.retention.auditDays).toBe(0);
    expect(config.scanning.idleMinutes).toBe(0);
    expect(config.scanning.waitSeconds).toBe(0);
    expect(config.metricsPort).toBe(0);
  });

  it("scan every platform listed, once each", async () => {
    const { config } = await load({ SCAN_PLATFORMS: "linux/amd64, linux/arm64/v8,linux/amd64" });
    expect(config.scanning.platforms).toEqual(["linux/amd64", "linux/arm64/v8"]);
  });
});
