// SPDX-License-Identifier: MIT
/** The Submit page's live DAG check (dagCheck.ts), which mirrors the server's rules. */
import { dump } from "js-yaml";
import { describe, expect, it } from "vitest";
import { checkDag, type DagCheck, type DagCheckContext } from "./dagCheck";

const anyone = { allowedSources: null, teamNames: null };

function task(id: string, fields: Record<string, unknown> = {}) {
  return { id, image: "registry.example/app:1", action: "create", team: "team-a", serviceAccount: "default", ...fields };
}

function check(dag: unknown, context: DagCheckContext = anyone): DagCheck {
  return checkDag(JSON.stringify(dag), context, (value) => dump(value));
}

function messages(result: DagCheck): string[] {
  return result.status === "invalid" ? result.issues.map((issue) => issue.message) : [];
}

describe("checkDag", () => {
  it("accepts a valid two-step DAG, in JSON or YAML", () => {
    const dag = { name: "demo", tasks: [task("a"), task("b", { dependsOn: ["a"] })] };
    expect(check(dag)).toMatchObject({ status: "valid", format: "JSON", taskCount: 2 });
    expect(checkDag(dump(dag), anyone, (value) => dump(value))).toMatchObject({ status: "valid", format: "YAML" });
  });

  it("leaves serviceAccount optional, but not empty", () => {
    const { serviceAccount: _unused, ...withoutOne } = task("a");
    expect(check({ name: "x", tasks: [withoutOne] }).status).toBe("valid");
    expect(messages(check({ name: "x", tasks: [task("a", { serviceAccount: "" })] }))).toContain(
      "Must be a non-empty string, or left out.",
    );
  });

  it("submits a catalog's kind: Dag file without its header, and explains a template", () => {
    const checked = check({ apiVersion: "vennir.dev/v2", kind: "Dag", name: "hello", tasks: [task("a")] });
    expect(checked.status).toBe("valid");
    if (checked.status === "valid") {
      expect(checked.payload).not.toHaveProperty("apiVersion");
      expect(checked.payload).not.toHaveProperty("kind");
    }
    expect(messages(check({ apiVersion: "vennir.dev/v2", kind: "Template", name: "t", steps: [] }))[0]).toContain("template");
    expect(check({ apiVersion: "vennir.dev/v1", name: "hello", tasks: [task("a")] }).status).toBe("invalid");
  });

  it("names the new field for one renamed since", () => {
    expect(messages(check({ externalReference: "old", tasks: [task("a")] }))).toEqual(
      expect.arrayContaining(['Renamed to "name": use "name" instead.']),
    );
    expect(messages(check({ name: "x", idempotencyKey: "k", tasks: [task("a")] }))).toEqual(['Renamed to "requestId": use "requestId" instead.']);
  });

  it("is empty for empty text", () => {
    expect(checkDag("  ", anyone, (value) => dump(value)).status).toBe("empty");
  });

  it("refuses a dependency listed twice, as the kernel does", () => {
    const dag = { name: "x", tasks: [task("a"), task("b", { dependsOn: ["a", "a"] })] };
    expect(messages(check(dag))).toContain('Lists "a" more than once.');
  });

  it("refuses depending on itself, on an unknown task, and loops", () => {
    expect(messages(check({ name: "x", tasks: [task("a", { dependsOn: ["a"] })] }))).toContain("A task can't depend on itself.");
    expect(messages(check({ name: "x", tasks: [task("a", { dependsOn: ["ghost"] })] })).join(" ")).toContain('"ghost"');
    const loop = { name: "x", tasks: [task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })] };
    expect(messages(check(loop)).join(" ")).toContain("loop");
  });

  it("refuses a Python field name the API would refuse", () => {
    expect(check({ name: "x", tasks: [task("a", { service_account: "billing-sa" })] }).status).toBe("invalid");
  });

  it("refuses a team the user can't submit for", () => {
    const result = check({ name: "x", tasks: [task("a", { team: "team-b" })] }, { allowedSources: null, teamNames: ["team-a"] });
    expect(result.status).toBe("invalid");
  });
});
