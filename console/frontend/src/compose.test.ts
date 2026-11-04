// SPDX-License-Identifier: MIT
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import type { Product } from "./api";
import { candidates, dagOf, inputsOf, newStep, problems, proposeUrl, stepsFromOrder, templateOf, templateYaml, type Draft } from "./compose";

const product = (team: string, name: string, action: string, input: object, output: object) =>
  ({ name: `${team}-${name}-${action}`, action, teamName: team, image: `r/${team}/${name}@sha256:aa`, inputSchema: input, outputSchema: output }) as unknown as Product;

const project = product("gcp-platform", "project", "create",
  { type: "object", required: ["projectId"], properties: { projectId: { type: "string", "x-vennir-needs": "gcp.project", pattern: "^[a-z]+$" } } },
  { type: "object", properties: { projectId: { type: "string", "x-vennir-provides": "gcp.project" }, url: { type: "string" } } });
const app = product("web", "app", "deploy",
  { type: "object", required: ["project", "replicas"], properties: { project: { type: "string", "x-vennir-needs": "gcp.project" }, replicas: { type: "integer" }, url: { type: "string" } } },
  { type: "object", properties: {} });
const products = new Map([project, app].map((p) => [p.name, p]));
const empty: Draft = { name: "web-on-gcp", displayName: "", description: "", team: "web", steps: [] };

describe("composing", () => {
  it("wires a new step's inputs from an earlier step's output of the same type", () => {
    const first = newStep(empty, products, project);
    const draft = { ...empty, steps: [first] };
    const second = newStep(draft, products, app);
    expect(second.inputs).toEqual({ project: { kind: "step", step: "project", output: "projectId" }, replicas: { kind: "unset" }, url: { kind: "unset" } });
    // The best fits first: by type, then by name.
    const url = inputsOf(app).find((i) => i.name === "url");
    expect(url && candidates(draft, products, 1, url).map((c) => `${c.output}:${c.match}`)).toEqual(["url:name", "projectId:other"]);
  });

  it("says what's missing before it's proposed", () => {
    const draft: Draft = { ...empty, steps: [newStep(empty, products, project)] };
    expect(problems(draft, products)).toEqual(['Step "project": projectId needs a value, a parameter, or an earlier step\'s output.']);
    expect(problems({ ...empty, name: "Not OK" }, products)).toContain("Add a step.");
  });

  it("makes a catalog template, with parameters for what's asked, and runnable steps only when nothing is", () => {
    const first = { ...newStep(empty, products, project), inputs: { projectId: { kind: "parameter" as const } } };
    const second = newStep({ ...empty, steps: [first] }, products, app);
    expect(second.id).toBe("app");
    second.inputs["replicas"] = { kind: "value", value: "3" };
    const draft: Draft = { ...empty, steps: [first, second] };
    expect(problems(draft, products)).toEqual([]);
    expect(templateOf(draft, products)).toMatchObject({
      kind: "Template",
      name: "web-on-gcp",
      parameters: { required: ["projectId"], properties: { projectId: { type: "string", pattern: "^[a-z]+$" } } },
      steps: [
        { id: "project", action: "gcp-platform/project.create", inputs: { projectId: { $param: "projectId" } } },
        { id: "app", action: "app.deploy", dependsOn: ["project"], inputs: { project: { $fromStep: "project", $output: "projectId" }, replicas: 3 } },
      ],
    });
    expect(load(templateYaml(draft, products))).toEqual(templateOf(draft, products));
    expect(dagOf(draft, products)).toBeNull();
    const fixed: Draft = { ...draft, steps: [{ ...first, inputs: { projectId: { kind: "value", value: "acme" } } }, second] };
    expect(dagOf(fixed, products)).toMatchObject({ tasks: [{ id: "project", team: "gcp-platform", inputs: { projectId: "acme" } }, { id: "app", dependsOn: ["project"], inputs: { project: { $fromTask: "project", $output: "projectId" } } }] });
    expect(proposeUrl("https://github.com/acme/catalog", draft, "x: 1")).toBe("https://github.com/acme/catalog/new/main?filename=teams%2Fweb%2Fdags%2Fweb-on-gcp.yaml&value=x%3A+1");
  });

  it("opens the order builder's steps, a shared type asked once by its name", () => {
    const steps = stepsFromOrder([
      { id: "project", product: project.name, inputs: { projectId: { kind: "parameter", parameter: "gcp.project" } } },
      { id: "app", product: app.name, inputs: { project: { kind: "parameter", parameter: "gcp.project" }, replicas: { kind: "unset" }, url: { kind: "step", step: "project", output: "url" } } },
    ]);
    expect(steps[1]?.inputs).toEqual({ project: { kind: "parameter", name: "gcp.project" }, replicas: { kind: "unset" }, url: { kind: "step", step: "project", output: "url" } });
    steps[1]!.inputs["replicas"] = { kind: "value", value: "2" };
    const template = templateOf({ ...empty, steps }, products) as { parameters: { required: string[]; properties: Record<string, unknown> }; steps: { inputs: Record<string, unknown> }[] };
    expect(template.parameters.required).toEqual(["gcp.project"]);
    expect(Object.keys(template.parameters.properties)).toEqual(["gcp.project"]);
    expect(template.steps[1]?.inputs["project"]).toEqual({ $param: "gcp.project" });
  });

  it("opens an existing resource the order uses as its value", () => {
    const [step] = stepsFromOrder([{ id: "app", product: app.name, inputs: { project: { kind: "resource", value: "web-prod" } } }]);
    expect(step?.inputs["project"]).toEqual({ kind: "value", value: "web-prod" });
  });
});
