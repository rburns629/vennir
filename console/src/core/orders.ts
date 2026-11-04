// SPDX-License-Identifier: MIT
/**
 * The order builder (decision 23): OrderService/PreviewOrder. A cart of
 * actions becomes one run's steps, each input wired by its wiring type: an
 * input's x-vennir-needs to the one output in the cart whose
 * x-vennir-provides is the same type (the catalog's wiring_types).
 *
 *   - Nothing in the cart provides a required input's type: what the team
 *     (or the caller) already has of it is offered, none chosen
 *     (CHOOSE_EXISTING, with "add a new one" when the type has a default
 *     provider), decision 25; with nothing there, the type's default
 *     provider (wiring_types.default_provider) is added as a step, or, for
 *     a shared type, one parameter (named for the type) is asked once for
 *     every input of that type.
 *   - An input of a type its own action provides names what it makes (a
 *     project.create's project id): the person's to fill, never wired.
 *   - An optional input nothing fills is suggested: its type's default
 *     provider, and what the team has of it. Nothing is added for it.
 *   - Two outputs could fill an input: it's left for the person, with the
 *     options (AMBIGUOUS), unless the request chose one.
 *   - Steps feeding each other round: CYCLE, and the cart's order kept.
 *
 * PreviewOrder never runs anything: Compose and the Catalog's cart show
 * what it answers. PlaceOrder (decided 2026-10-27) runs a cart once its
 * choices are made and its values given: one run for the team, each step
 * as running its action alone would be (templates.ts's runOrderSteps), so a
 * member checks out what they could run step by step, with no raw DAG.
 * Ordering bots still order templates only (decision 23). planOrder is the
 * whole of the wiring, without I/O; previewOrder checks who may and loads
 * what it needs.
 */
import { Code } from "@connectrpc/connect";
import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "../apiError.js";
import { ensureMayOrder, ensureTeamMember } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { findRunnableProduct, listWiringTypes, type WiringType } from "../db/queries.js";
import { resources } from "../db/schema.js";
import { runOrderSteps, type OrderRunStep, type TeamProduct } from "./templates.js";

export const MAX_CART = 50;
/** Resources looked at for what an order could use. */
const MAX_EXISTING = 500;

export type OrderInput =
  | { kind: "step"; step: string; output: string }
  | { kind: "parameter"; parameter: string }
  // Something already deployed: the value it provides.
  | { kind: "resource"; resourceId: string; value: string }
  | { kind: "unset" };

/** How an input is filled: another step's output, an existing resource, or a new one (the type's default provider). */
export interface OrderChoice {
  step: string;
  input: string;
  fromStep?: string;
  fromOutput?: string;
  resourceId?: string;
  addNew?: boolean;
  /** For people: what the option is. */
  label?: string;
}

/** A resource the order could use: something the team (or the caller) already has, of a wiring type. */
export interface ExistingResource {
  id: string;
  wiringType: string;
  value: string;
  label: string;
}

/** An optional input nothing fills: what could. Not in the order until chosen. */
export interface OrderSuggestion {
  step: string;
  input: string;
  wiringType: string;
  /** The type's default provider, to add to the cart; null when there's none for the caller. */
  provider: string | null;
  existing: OrderChoice[];
}

export interface OrderStep {
  id: string;
  product: string;
  inputs: Record<string, OrderInput>;
  added: boolean;
}

export interface OrderProblem {
  code: "AMBIGUOUS" | "NO_PROVIDER" | "CHOOSE_EXISTING" | "CYCLE";
  step: string;
  input: string;
  message: string;
  options: OrderChoice[];
}

interface Field {
  name: string;
  required: boolean;
  /** x-vennir-needs on an input, x-vennir-provides on an output. */
  wiring: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function fields(schema: unknown, hint: "x-vennir-needs" | "x-vennir-provides"): Field[] {
  const s = isRecord(schema) ? schema : {};
  const properties = isRecord(s["properties"]) ? s["properties"] : {};
  const required = Array.isArray(s["required"]) ? s["required"] : [];
  return Object.entries(properties).map(([name, raw]) => {
    const wiring = isRecord(raw) ? raw[hint] : undefined;
    return { name, required: required.includes(name), wiring: typeof wiring === "string" ? wiring : null };
  });
}

/** "<team>/<product>.<action>" (a default provider) as its registered name, <team>-<product>-<action>. */
export function registeredName(ref: string): string | null {
  const m = /^([a-z0-9-]+)\/([a-z0-9-]+)\.([a-z0-9-]+)$/.exec(ref);
  return m ? `${m[1] ?? ""}-${m[2] ?? ""}-${m[3] ?? ""}` : null;
}

/** A step's id: its product's own name (without its team and action), made unique. */
function stepId(product: TeamProduct, taken: Set<string>): string {
  const prefix = `${product.teamName}-`;
  const suffix = `-${product.action}`;
  const base =
    product.name.startsWith(prefix) && product.name.endsWith(suffix) && product.name.length > prefix.length + suffix.length
      ? product.name.slice(prefix.length, -suffix.length)
      : product.action;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${String(n)}`;
  taken.add(id);
  return id;
}

/**
 * Wires a cart. `products` are the cart's, in its order; `defaults` resolves
 * a default provider (null: not here, or not for this caller).
 */
export function planOrder(
  cart: TeamProduct[],
  types: Pick<WiringType, "name" | "shared" | "defaultProvider">[],
  defaults: Map<string, TeamProduct | null>,
  choices: OrderChoice[],
  existing: ExistingResource[] = [],
): { steps: OrderStep[]; problems: OrderProblem[]; suggestions: OrderSuggestion[] } {
  const typeOf = new Map(types.map((t) => [t.name, t]));
  const taken = new Set<string>();
  const planned = cart.map((product) => ({ id: stepId(product, taken), product, added: false }));
  const problems: OrderProblem[] = [];
  const suggestions: OrderSuggestion[] = [];

  const provides = (product: TeamProduct, type: string) => fields(product.outputSchema, "x-vennir-provides").some((o) => o.wiring === type);
  const provided = (type: string) => planned.some((s) => provides(s.product, type));
  const existingOf = (type: string) => existing.filter((r) => r.wiringType === type);
  const choiceFor = (step: string, input: string) => choices.find((c) => c.step === step && c.input === input);
  // Default providers, until nothing more is needed: a provider added may
  // need its own. Each is added once, whatever it turns out to provide.
  const added = new Set<string>();
  // A for...of over an array visits what's pushed onto it while it runs.
  for (const step of planned) {
    for (const input of fields(step.product.inputSchema, "x-vennir-needs")) {
      if (!input.required || !input.wiring || provided(input.wiring) || provides(step.product, input.wiring)) continue;
      const type = typeOf.get(input.wiring);
      if (!type || type.shared || !type.defaultProvider || added.has(type.defaultProvider)) continue;
      // What's already there is the person's to choose; a new one only if asked.
      const choice = choiceFor(step.id, input.name);
      if (existingOf(input.wiring).length > 0 && !choice?.addNew) continue;
      if (choice?.resourceId) continue;
      added.add(type.defaultProvider);
      const provider = defaults.get(type.defaultProvider);
      if (provider) planned.push({ id: stepId(provider, taken), product: provider, added: true });
    }
  }

  const steps: OrderStep[] = planned.map((s) => {
    const inputs: Record<string, OrderInput> = {};
    for (const input of fields(s.product.inputSchema, "x-vennir-needs")) {
      inputs[input.name] = { kind: "unset" };
      if (!input.wiring) continue;
      const options: OrderChoice[] = planned
        .filter((other) => other.id !== s.id)
        .flatMap((other) =>
          fields(other.product.outputSchema, "x-vennir-provides")
            .filter((o) => o.wiring === input.wiring)
            .map((o) => ({ step: s.id, input: input.name, fromStep: other.id, fromOutput: o.name })),
        );
      // What it makes (project.create's project id): the person's.
      if (provides(s.product, input.wiring)) continue;
      const chosen = choiceFor(s.id, input.name);
      const there = existingOf(input.wiring);
      const resource = chosen?.resourceId ? there.find((r) => r.id === chosen.resourceId) : undefined;
      const pick = chosen?.fromStep
        ? options.find((o) => o.fromStep === chosen.fromStep && o.fromOutput === chosen.fromOutput)
        : !resource && options.length === 1
          ? options[0]
          : undefined;
      const provider = typeOf.get(input.wiring)?.defaultProvider ?? null;
      const providerHere = provider ? (defaults.get(provider) ?? null) : null;
      const asOptions = (step: string) =>
        there.map((r): OrderChoice => ({ step, input: input.name, resourceId: r.id, label: r.label }));
      if (resource) {
        inputs[input.name] = { kind: "resource", resourceId: resource.id, value: resource.value };
      } else if (pick?.fromStep && pick.fromOutput) {
        inputs[input.name] = { kind: "step", step: pick.fromStep, output: pick.fromOutput };
      } else if (options.length > 1) {
        problems.push({ code: "AMBIGUOUS", step: s.id, input: input.name, message: `${s.id}'s ${input.name} (${input.wiring}) could come from ${options.map((o) => `${o.fromStep ?? ""}.${o.fromOutput ?? ""}`).join(" or ")}: choose one.`, options });
      } else if (typeOf.get(input.wiring)?.shared) {
        inputs[input.name] = { kind: "parameter", parameter: input.wiring };
      } else if (!input.required) {
        if (there.length > 0 || providerHere) {
          suggestions.push({ step: s.id, input: input.name, wiringType: input.wiring, provider: providerHere?.name ?? null, existing: asOptions(s.id) });
        }
      } else if (there.length > 0) {
        problems.push({
          code: "CHOOSE_EXISTING",
          step: s.id,
          input: input.name,
          message: `${s.id}'s ${input.name} (${input.wiring}): use one you already have (${there.map((r) => r.label).join(", ")})${providerHere ? ", or add a new one" : ""}.`,
          options: [...asOptions(s.id), ...(providerHere ? [{ step: s.id, input: input.name, addNew: true, label: `A new one (${providerHere.name})` }] : [])],
        });
      } else {
        const provider = typeOf.get(input.wiring)?.defaultProvider;
        problems.push({
          code: "NO_PROVIDER",
          step: s.id,
          input: input.name,
          message: `Nothing in the order provides ${input.wiring} for ${s.id}'s ${input.name}${provider ? ` (its default, ${provider}, isn't available to you)` : ""}: give it a value, or add a step that provides it.`,
          options: [],
        });
      }
    }
    return { id: s.id, product: s.product.name, inputs, added: s.added };
  });

  // Each step after those it takes outputs from (Kahn's, keeping the cart's order among equals).
  const ordered: OrderStep[] = [];
  const left = [...steps];
  while (left.length > 0) {
    const next = left.findIndex((s) =>
      Object.values(s.inputs).every((i) => i.kind !== "step" || ordered.some((o) => o.id === i.step)),
    );
    if (next === -1) {
      problems.push({ code: "CYCLE", step: left.map((s) => s.id).join(", "), input: "", message: `These steps take each other's outputs, round in a circle: ${left.map((s) => s.id).join(", ")}. Choose a value for one of their inputs.`, options: [] });
      ordered.push(...left);
      break;
    }
    ordered.push(...left.splice(next, 1));
  }
  return { steps: ordered, problems, suggestions };
}

/** Whether `who` may use a product in an order: its team's own, or shared with one of theirs. */
function mayUse(who: AuthUser, product: TeamProduct): boolean {
  return who.isAdmin || who.teamNames.includes(product.teamName) || product.shareWith.includes("*") || who.teamNames.some((t) => product.shareWith.includes(t));
}

export async function previewOrder(caller: AuthUser | undefined, request: { team: string; actions: string[]; choices: OrderChoice[] }) {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  const who = caller;
  ensureMayOrder(who);
  ensureTeamMember(who, request.team);
  if (request.actions.length === 0) throw new ApiError(400, "BAD_REQUEST", "Put at least one action in the order.");
  if (request.actions.length > MAX_CART) throw new ApiError(400, "BAD_REQUEST", `An order has at most ${String(MAX_CART)} actions.`);
  const cart: TeamProduct[] = [];
  for (const name of request.actions) {
    const product = await findRunnableProduct(name);
    if (!product || !mayUse(who, product)) throw new ApiError(404, "NOT_FOUND", `No action "${name}" that's shared with you.`);
    cart.push(product);
  }
  const types = await listWiringTypes();
  const shared = new Set(types.filter((t) => t.shared).map((t) => t.name));
  // What the team, or the caller, already has, by what it provides. (Never a
  // gateway's API: those are called through the gateway, not wired in.)
  const found = await db
    .select({ id: resources.id, type: resources.type, externalId: resources.externalId, name: resources.name, provides: resources.provides })
    .from(resources)
    .where(and(isNull(resources.deletedAt), or(eq(resources.ownerTeam, request.team), eq(resources.ownerUserId, who.id))))
    .limit(MAX_EXISTING);
  const existing: ExistingResource[] = found.flatMap((r) =>
    r.provides
      .filter((p) => !shared.has(p.type))
      .map((p) => ({ id: r.id, wiringType: p.type, value: p.value, label: `${r.name ?? r.externalId} (${r.type})` })),
  );
  const defaults = new Map<string, TeamProduct | null>();
  for (const ref of new Set(types.map((t) => t.defaultProvider).filter((p): p is string => p !== null))) {
    const name = registeredName(ref);
    const product = name ? await findRunnableProduct(name) : undefined;
    defaults.set(ref, product && mayUse(who, product) ? product : null);
  }
  return planOrder(cart, types, defaults, request.choices, existing);
}

/** A cart to place: its actions, its choices, the person's values (by step, then input) and its shared types' values. */
export interface Cart {
  team: string;
  actions: string[];
  choices: OrderChoice[];
  values: Record<string, Record<string, unknown>>;
  parameters: Record<string, unknown>;
  requestId?: string | undefined;
}

const record = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

/** An order's run's stored cart (submitted_executions.template_parameters), for a rerun. */
export function cartOf(stored: unknown, team: string): Cart {
  const s = record(stored);
  return {
    team,
    actions: Array.isArray(s["actions"]) ? s["actions"].filter((a): a is string => typeof a === "string") : [],
    choices: Array.isArray(s["choices"]) ? (s["choices"].filter(isRecord) as unknown as OrderChoice[]) : [],
    values: Object.fromEntries(Object.entries(record(s["values"])).map(([k, v]) => [k, record(v)])),
    parameters: record(s["parameters"]),
  };
}

/**
 * Places a cart: plans it as PreviewOrder does, refuses it while a choice is
 * unmade or a required value without a provider is missing
 * (ORDER_INCOMPLETE, with what's left), and runs it.
 */
export async function placeOrder(caller: AuthUser | undefined, cart: Cart, log: FastifyBaseLogger) {
  const plan = await previewOrder(caller, { team: cart.team, actions: cart.actions, choices: cart.choices });
  const left = plan.problems.filter((p) => !(p.code === "NO_PROVIDER" && cart.values[p.step]?.[p.input] !== undefined));
  if (left.length > 0) {
    throw new ApiError(
      422,
      "ORDER_INCOMPLETE",
      `The order isn't ready: ${left.map((p) => p.message).join(" ")}`,
      Code.FailedPrecondition,
      { problems: left.map((p) => ({ code: p.code, step: p.step, input: p.input, message: p.message })) },
    );
  }
  const steps: OrderRunStep[] = [];
  for (const planned of plan.steps) {
    const product = await findRunnableProduct(planned.product);
    if (!product) throw new ApiError(404, "NOT_FOUND", `No action "${planned.product}" any more.`);
    const inputs: Record<string, unknown> = {};
    const dependsOn = new Set<string>();
    for (const [name, input] of Object.entries(planned.inputs)) {
      let value: unknown;
      if (input.kind === "step") {
        value = { $fromTask: input.step, $output: input.output };
        dependsOn.add(input.step);
      } else if (input.kind === "parameter") value = cart.parameters[input.parameter];
      else if (input.kind === "resource") value = input.value;
      else value = cart.values[planned.id]?.[name];
      if (value !== undefined) inputs[name] = value;
    }
    steps.push({ id: planned.id, product, inputs, dependsOn: [...dependsOn] });
  }
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  const name = `Order: ${steps.map((s) => s.id).join(", ")}`.slice(0, 200);
  return runOrderSteps(
    caller,
    name,
    steps,
    cart.team,
    // As the run's page shows what was ordered: the cart, and each planned
    // step's product, with those the plan added marked.
    {
      actions: cart.actions,
      choices: cart.choices,
      values: cart.values,
      parameters: cart.parameters,
      steps: plan.steps.map((s) => ({ id: s.id, product: s.product, added: s.added })),
    },
    cart.requestId,
    log,
  );
}
