// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { returnPath } from "./returnTo";

describe("where signing in goes back to", () => {
  it("is one of this console's own pages", () => {
    expect(returnPath({ from: "/runs/r1?tab=logs#t" })).toBe("/runs/r1?tab=logs#t");
    expect(returnPath({ from: "/teams/payments?tab=schedules" })).toBe("/teams/payments?tab=schedules");
    expect(returnPath({ from: "/login-help" })).toBe("/login-help");
  });

  it("is Home for anything else: another site, the sign-in pages, nothing", () => {
    for (const from of ["//evil.example/x", "/\\evil.example", "https://evil.example/", "runs/r1", "/login", "/login?x=1", "/choose-password", 7]) {
      expect(returnPath({ from })).toBe("/");
    }
    expect(returnPath(null)).toBe("/");
    expect(returnPath(undefined)).toBe("/");
  });
});
