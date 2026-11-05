// SPDX-License-Identifier: MIT
/** Failure help: the owner's words first, the platform's for its own codes, and whether a retry is safe. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { failureHelp, PLATFORM_ERRORS } from "../src/failureHelp.js";

const team = { name: "gcp-platform", contact: "gcp@acme.com", helpChat: "#gcp-help", helpUrl: "https://runbooks.acme.com/gcp" };
const product = (idempotent: boolean) => ({
  idempotent,
  errorHelp: { QUOTA_EXCEEDED: { means: "No Cloud SQL quota left.", do: "Ask for more, then retry." }, TASK_TIMEOUT: { means: "Instances can take 20 minutes." } },
});

describe("failure help", () => {
  it("uses the owner's words for its codes, and says whom to ask", () => {
    expect(failureHelp("QUOTA_EXCEEDED", product(true), team)).toEqual({
      means: "No Cloud SQL quota left.",
      do: "Ask for more, then retry.",
      fromOwner: true,
      retry: "safe",
      team: "gcp-platform",
      contact: "gcp@acme.com",
      chat: "#gcp-help",
      url: "https://runbooks.acme.com/gcp",
    });
  });

  it("lets the owner explain a platform code, and the platform explain the rest", () => {
    expect(failureHelp("TASK_TIMEOUT", product(true), team)).toMatchObject({ means: "Instances can take 20 minutes.", fromOwner: true });
    expect(failureHelp("IMAGE_SCAN_FAILED", product(true), team)).toMatchObject({
      means: PLATFORM_ERRORS["IMAGE_SCAN_FAILED"]?.means,
      fromOwner: false,
    });
    expect(failureHelp("SOMETHING_ELSE", product(true), team)).toMatchObject({ means: "", do: "" });
  });

  it("says a retry is safe only for an idempotent product", () => {
    expect(failureHelp("X_FAILED", product(false), team).retry).toBe("unsafe");
    expect(failureHelp("X_FAILED", undefined, undefined)).toMatchObject({ retry: "unknown", team: "", chat: "" });
  });

  it("explains every code the kernel reserves for the platform", () => {
    // kernel/internal/domain/result.go: RefusalCodes and ReservedCodes.
    const source = readFileSync(new URL("../../kernel/internal/domain/result.go", import.meta.url), "utf8");
    const listed = (name: string) => {
      const start = source.indexOf(`var ${name} = `);
      return start < 0 ? "" : source.slice(start, source.indexOf("\n\n", start));
    };
    const codes = [...(listed("RefusalCodes") + listed("ReservedCodes")).matchAll(/"([A-Z][A-Z_]+)"/g)].map((m) => m[1] ?? "");
    expect(codes).toContain("TASK_TIMEOUT");
    expect(codes.filter((code) => !(code in PLATFORM_ERRORS))).toEqual([]);
    expect(PLATFORM_ERRORS).toHaveProperty("PRODUCT_CODE_RESERVED");
  });
});
