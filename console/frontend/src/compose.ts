// SPDX-License-Identifier: MIT
/**
 * Compose: a template built in the browser from actions, each input given
 * a value, asked for when it runs (a parameter), or wired from an earlier
 * step's output. Wiring is matched by type: an input's x-vertra-needs and
 * an output's x-vertra-provides (the catalog's wiring types), else by the
 * same name. What it makes is a catalog template (kind: Template), to
 * propose in the catalog repository, or, when every step is the person's
 * own team's and nothing is asked, a DAG they can run now.
 */
import { dump as dumpYaml } from "js-yaml";
import type { Product } from "./api";
import { catalogFileUrl } from "./catalogFile";

export type InputSource =
  | { kind: "value"; value: string }
  // Asked when it runs: a parameter named for the input, or `name` (the order
  // builder asks a shared wiring type's once, by the type).
  | { kind: "parameter"; name?: string }
  | { kind: "step"; step: string; output: string }
  | { kind: "unset" };

export interface ComposeStep {
  id: string;
  /** The registered product (<team>-<product>-<action>). */
  product: string;
  inputs: Record<string, InputSource>;
}

export interface Draft {
  name: string;
  displayName: string;
  description: string;
  /** The team the template is for: its catalog folder. */
  team: string;
  steps: ComposeStep[];
}

export interface Field {
  name: string;
  type: string;
  required: boolean;
  /** Its wiring type: x-vertra-needs on an input, x-vertra-provides on an output. */
  wiring: string | null;
  description: string;
  schema: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function fieldsOf(schema: Record<string, unknown>, hint: "x-vertra-needs" | "x-vertra-provides"): Field[] {
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const required = Array.isArray(schema["required"]) ? schema["required"] : [];
  return Object.entries(properties).map(([name, raw]) => {
    const p = isRecord(raw) ? raw : {};
    return {
      name,
      type: typeof p["type"] === "string" ? p["type"] : "any",
      required: required.includes(name),
      wiring: typeof p[hint] === "string" ? p[hint] : null,
      description: typeof p["description"] === "string" ? p["description"] : "",
      schema: p,
    };
  });
}

export const inputsOf = (p: Pick<Product, "inputSchema">) => fieldsOf(p.inputSchema, "x-vertra-needs");
export const outputsOf = (p: Pick<Product, "outputSchema">) => fieldsOf(p.outputSchema, "x-vertra-provides");

/** "gcp-platform-project-create" → "project.create" in its own team, else "gcp-platform/project.create". */
export function actionRef(product: Pick<Product, "name" | "action" | "teamName">, forTeam: string): string {
  const team = product.teamName ?? "";
  const prefix = `${team}-`;
  const suffix = `-${product.action}`;
  const name = product.name.startsWith(prefix) && product.name.endsWith(suffix) ? product.name.slice(prefix.length, -suffix.length) : product.name;
  return team === forTeam ? `${name}.${product.action}` : `${team}/${name}.${product.action}`;
}

export interface Candidate {
  step: string;
  output: string;
  /** Why it fits: the same wiring type, or the same name. */
  match: "type" | "name" | "other";
}

/** Earlier steps' outputs an input could take, the best fits first. */
export function candidates(draft: Draft, products: Map<string, Product>, stepIndex: number, input: Field): Candidate[] {
  const out: Candidate[] = [];
  for (const step of draft.steps.slice(0, stepIndex)) {
    const product = products.get(step.product);
    if (!product) continue;
    for (const output of outputsOf(product)) {
      const match = input.wiring && output.wiring === input.wiring ? "type" : output.name === input.name ? "name" : "other";
      out.push({ step: step.id, output: output.name, match });
    }
  }
  const rank = { type: 0, name: 1, other: 2 } as const;
  return out.sort((a, b) => rank[a.match] - rank[b.match]);
}

/** A new step for a product: each input wired from the best earlier fit by type, else left to fill in. */
export function newStep(draft: Draft, products: Map<string, Product>, product: Product): ComposeStep {
  // Its product's own name: <team>-<product>-<action> without the team and action.
  const team = `${product.teamName ?? ""}-`;
  const action = `-${product.action}`;
  const base = product.name.startsWith(team) && product.name.endsWith(action) ? product.name.slice(team.length, -action.length) : product.action;
  let id = base;
  for (let n = 2; draft.steps.some((s) => s.id === id); n++) id = `${base}-${String(n)}`;
  const inputs: Record<string, InputSource> = {};
  for (const input of inputsOf(product)) {
    const typed = input.wiring ? candidates(draft, products, draft.steps.length, input).find((c) => c.match === "type") : undefined;
    inputs[input.name] = typed ? { kind: "step", step: typed.step, output: typed.output } : { kind: "unset" };
  }
  return { id, product: product.name, inputs };
}

/** What's wrong with it, before it's proposed or run. */
export function problems(draft: Draft, products: Map<string, Product>): string[] {
  const out: string[] = [];
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(draft.name)) out.push("Its name is lower-case letters, digits and hyphens.");
  if (!draft.team) out.push("Choose the team it's for.");
  if (draft.steps.length === 0) out.push("Add a step.");
  const seen = new Set<string>();
  draft.steps.forEach((step, i) => {
    if (seen.has(step.id)) out.push(`Two steps are called "${step.id}".`);
    seen.add(step.id);
    const product = products.get(step.product);
    if (!product) {
      out.push(`Step "${step.id}": its action is no longer in the catalog.`);
      return;
    }
    for (const input of inputsOf(product)) {
      const source = step.inputs[input.name] ?? { kind: "unset" };
      if (input.required && (source.kind === "unset" || (source.kind === "value" && source.value === ""))) {
        out.push(`Step "${step.id}": ${input.name} needs a value, a parameter, or an earlier step's output.`);
      }
      if (source.kind === "step" && !draft.steps.slice(0, i).some((s) => s.id === source.step)) {
        out.push(`Step "${step.id}": ${input.name} comes from "${source.step}", which isn't an earlier step.`);
      }
    }
  });
  return out;
}

/** A value typed in, read as its input's type (a number, true/false, JSON), else as text. */
function typed(value: string, input: Field | undefined): unknown {
  if (input?.type === "string" || input === undefined) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** The catalog template it makes (kind: Template), as an object. */
export function templateOf(draft: Draft, products: Map<string, Product>): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  const required: string[] = [];
  const steps = draft.steps.map((step) => {
    const product = products.get(step.product);
    const fields = new Map((product ? inputsOf(product) : []).map((f) => [f.name, f]));
    const inputs: Record<string, unknown> = {};
    const dependsOn = new Set<string>();
    for (const [name, source] of Object.entries(step.inputs)) {
      const field = fields.get(name);
      if (source.kind === "value" && source.value !== "") inputs[name] = typed(source.value, field);
      if (source.kind === "step") {
        inputs[name] = { $fromStep: source.step, $output: source.output };
        dependsOn.add(source.step);
      }
      if (source.kind === "parameter") {
        // One parameter per name; a second step asking for the same one shares it.
        const param = source.name ?? name;
        parameters[param] ??= field?.schema ?? { type: "string" };
        if (field?.required && !required.includes(param)) required.push(param);
        inputs[name] = { $param: param };
      }
    }
    return {
      id: step.id,
      action: product ? actionRef(product, draft.team) : step.product,
      ...(dependsOn.size > 0 ? { dependsOn: [...dependsOn] } : {}),
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    };
  });
  return {
    apiVersion: "vertra.dev/v2",
    kind: "Template",
    name: draft.name,
    displayName: draft.displayName || draft.name,
    description: draft.description || `${draft.steps.length === 1 ? "One step" : `${String(draft.steps.length)} steps`}, made in Compose.`,
    parameters: { type: "object", additionalProperties: false, ...(required.length > 0 ? { required } : {}), properties: parameters },
    steps,
  };
}

/** The template as its catalog file. */
export function templateYaml(draft: Draft, products: Map<string, Product>): string {
  return `# Made in Compose: review it, then open a pull request.\n${dumpYaml(templateOf(draft, products), { lineWidth: 100 })}`;
}

/** Whether it asks for anything when it runs. */
export const hasParameters = (draft: Draft) => draft.steps.some((s) => Object.values(s.inputs).some((i) => i.kind === "parameter"));

/** The DAG to run it now: only when nothing's asked and every step is a product of `team`. */
export function dagOf(draft: Draft, products: Map<string, Product>): Record<string, unknown> | null {
  if (hasParameters(draft)) return null;
  const tasks = draft.steps.map((step) => {
    const product = products.get(step.product);
    if (!product?.teamName) return null;
    const fields = new Map(inputsOf(product).map((f) => [f.name, f]));
    const inputs: Record<string, unknown> = {};
    const dependsOn = new Set<string>();
    for (const [name, source] of Object.entries(step.inputs)) {
      if (source.kind === "value" && source.value !== "") inputs[name] = typed(source.value, fields.get(name));
      if (source.kind === "step") {
        inputs[name] = { $fromTask: source.step, $output: source.output };
        dependsOn.add(source.step);
      }
    }
    return {
      id: step.id,
      image: product.image,
      action: product.action,
      team: product.teamName,
      inputs,
      ...(dependsOn.size > 0 ? { dependsOn: [...dependsOn] } : {}),
    };
  });
  if (tasks.some((t) => t === null)) return null;
  return { name: draft.name, tasks };
}

/** GitHub's page for a new file in the catalog repository, filled in. Null when the repository isn't known. */
export function proposeUrl(repository: string | null, draft: Draft, yaml: string): string | null {
  if (!repository) return null;
  return catalogFileUrl(repository, `teams/${draft.team}/dags/${draft.name}.yaml`, "new", yaml);
}

/** A step as the order builder (OrderService/PreviewOrder) answers it. */
export interface BuiltStep {
  id: string;
  product: string;
  /** Added by the order builder (a type's default provider), not in the cart. */
  added?: boolean;
  inputs: Record<string, { kind: string; step?: string; output?: string; parameter?: string; value?: string }>;
}

/** The order builder's steps as Compose's: wired, asked once, an existing resource's value, or left to fill in. */
export function stepsFromOrder(steps: BuiltStep[]): ComposeStep[] {
  return steps.map((s) => ({
    id: s.id,
    product: s.product,
    inputs: Object.fromEntries(
      Object.entries(s.inputs).map(([name, i]): [string, InputSource] => [
        name,
        i.kind === "step" && i.step && i.output
          ? { kind: "step", step: i.step, output: i.output }
          : i.kind === "parameter" && i.parameter
            ? { kind: "parameter", name: i.parameter }
            : i.kind === "resource" && i.value !== undefined
              ? { kind: "value", value: i.value }
              : { kind: "unset" },
      ]),
    ),
  }));
}
