// SPDX-License-Identifier: MIT
/**
 * The chat agent's tools (decision 24): each runs the console's own code as
 * the signed-in person, so the agent sees and does exactly what they may
 * through the API, never more. Facts about the platform come only from
 * here (Correctness): the model words them. No tool changes anything: the
 * nearest is propose_cart, a cart the person opens and places themselves.
 */
import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "../apiError.js";
import type { AuthUser } from "../auth/plugin.js";
import { executionDetail } from "../core/executions.js";
import { previewOrder, type OrderChoice } from "../core/orders.js";
import { listResources } from "../core/resources.js";
import { runnables } from "../core/templates.js";
import { findRunnableProduct, listWiringTypes } from "../db/queries.js";
import { guideIndex } from "../guideSearch.js";
import { asSources, linkOf, type Source } from "./citations.js";
import type { ToolSpec } from "./model.js";

/** What one turn's tools found, for the answer and the panel. */
export interface TurnState {
  caller: AuthUser;
  /** The team the person is ordering for, if they've said. */
  team: string | null;
  log: FastifyBaseLogger;
  /** Doc sections retrieved, numbered: what the answer may cite. */
  sources: Source[];
  /** The cart the agent proposes, for the person to open. */
  cart: ProposedCart | null;
}

/** A cart for the person to open: its actions, and the choices and values they gave, for them to check and place. */
export interface ProposedCart {
  team: string;
  actions: string[];
  choices: OrderChoice[];
  /** By step, then input: what the person said to fill in. */
  values: Record<string, Record<string, string | number | boolean>>;
}

interface Tool {
  spec: ToolSpec;
  run(state: TurnState, args: Record<string, unknown>): Promise<unknown>;
}

export const MAX_RESULT = 7000;

const text = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : "");

/** A tool's result as the model reads it: JSON, cut short when long. */
export function forModel(result: unknown): string {
  const json = JSON.stringify(result);
  return json.length > MAX_RESULT ? `${json.slice(0, MAX_RESULT)}... (cut short)` : json;
}

/** A schema's properties as a short list: name, type, required, its wiring type, its description. */
function fieldsOf(schema: unknown, hint: "x-vennir-needs" | "x-vennir-provides") {
  const s = typeof schema === "object" && schema !== null ? (schema as Record<string, unknown>) : {};
  const properties = (typeof s["properties"] === "object" && s["properties"] !== null ? s["properties"] : {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(s["required"]) ? s["required"] : [];
  return Object.entries(properties).map(([name, p]) => ({
    name,
    type: p["type"] ?? null,
    required: required.includes(name),
    ...(typeof p[hint] === "string" ? { wiringType: p[hint] } : {}),
    ...(p["default"] !== undefined ? { default: p["default"] } : {}),
    description: text(p["description"], 300),
  }));
}

const CHOICE = {
  type: "object",
  required: ["step", "input"],
  properties: {
    step: { type: "string" },
    input: { type: "string" },
    resourceId: { type: "string" },
    addNew: { type: "boolean" },
    fromStep: { type: "string" },
    fromOutput: { type: "string" },
  },
  description: "One of plan_order's options for an input, as it gave it.",
};

/** The model's choices, in OrderChoice's shape: only the fields an option has. */
function choicesOf(given: unknown): OrderChoice[] {
  if (!Array.isArray(given)) return [];
  return given.slice(0, 50).flatMap((c: unknown) => {
    if (typeof c !== "object" || c === null) return [];
    const r = c as Record<string, unknown>;
    const step = text(r["step"], 100);
    const input = text(r["input"], 100);
    if (!step || !input) return [];
    return [{
      step,
      input,
      ...(text(r["resourceId"], 64) ? { resourceId: text(r["resourceId"], 64) } : {}),
      ...(r["addNew"] === true ? { addNew: true } : {}),
      ...(text(r["fromStep"], 100) ? { fromStep: text(r["fromStep"], 100), fromOutput: text(r["fromOutput"], 100) } : {}),
    }];
  });
}

/** The values the model fills in: for the plan's steps and their unfilled inputs only, scalars, kept short. */
function valuesOf(given: unknown, unset: Map<string, Set<string>>): ProposedCart["values"] {
  const out: ProposedCart["values"] = {};
  if (typeof given !== "object" || given === null) return out;
  for (const [step, inputs] of Object.entries(given as Record<string, unknown>)) {
    const names = unset.get(step);
    if (!names || typeof inputs !== "object" || inputs === null) continue;
    for (const [input, value] of Object.entries(inputs as Record<string, unknown>)) {
      if (!names.has(input)) continue;
      if ((typeof value === "string" && value.length <= 1000) || typeof value === "number" || typeof value === "boolean") {
        (out[step] ??= {})[input] = value;
      }
    }
  }
  return out;
}

function teamFor(state: TurnState, given: unknown): string {
  const team = text(given, 100) || state.team || state.caller.teamNames[0] || "";
  if (!team) throw new Error("No team: the person isn't in one. Say they need one to order.");
  return team;
}

const TOOLS: Tool[] = [
  {
    spec: {
      name: "search_docs",
      description:
        "Search Vennir's docs (guides, how it works, how to run it) for the sections that answer a question. Answer only from what this returns, citing each section's id, like [S1]. Set why to true only for a question of why something was decided: it adds design history (decisions, with rejected options), which is never how things work now.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string", description: "The question, in plain words." }, why: { type: "boolean" } },
      },
    },
    async run(state, args) {
      const hits = (await guideIndex()).search(text(args["query"]), 5, args["why"] === true);
      const sources = asSources(hits, state.sources.length);
      state.sources.push(...sources);
      if (sources.length === 0) return { found: [], note: "Nothing in the docs matches: say the docs don't cover it." };
      return { found: sources.map((s) => ({ id: s.id, doc: s.title, section: s.heading, kind: s.kind, excerpt: s.excerpt })) };
    },
  },
  {
    spec: {
      name: "read_doc_section",
      description: "Read one section of a doc in full, when an excerpt from search_docs isn't enough. Give the doc and section as search_docs named them; cite it by the id this returns.",
      parameters: { type: "object", required: ["doc", "section"], properties: { doc: { type: "string" }, section: { type: "string" } } },
    },
    async run(state, args) {
      const index = await guideIndex();
      const wanted = text(args["doc"], 200);
      const known = state.sources.find((s) => s.guide === wanted || s.title === wanted);
      const guide = known?.guide ?? wanted;
      const section = index.section(guide, text(args["section"], 200));
      if (!section) return { error: "No such section. Search first, and use a doc and section it names.", sections: index.headings(guide).slice(0, 40) };
      const [source] = asSources([{ guide: section.guide, title: section.title, kind: section.kind, heading: section.heading, excerpt: "", score: 0 }], state.sources.length);
      if (!source) return { error: "No such section." };
      state.sources.push(source);
      return { id: source.id, doc: section.title, section: section.heading, kind: section.kind, text: section.text.slice(0, 6000), link: linkOf(section) };
    },
  },
  {
    spec: {
      name: "find_offerings",
      description: "Find what the person can order: the catalog's templates and actions shared with them, matching some words (\"app hosting\", \"database\"). Gives each one's name to use with describe_offering, plan_order and propose_cart.",
      parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
    },
    async run(state, args) {
      const words = text(args["query"], 200).toLowerCase().split(/\W+/).filter(Boolean);
      const all = (await runnables(state.caller)).filter((r) => r.shared);
      const scored = all
        .map((r) => {
          const haystack = `${r.displayName} ${r.name} ${r.team} ${r.description}`.toLowerCase();
          return { r, score: words.filter((w) => haystack.includes(w)).length };
        })
        .filter((x) => x.score > 0 || words.length === 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      return {
        offerings: scored.map(({ r }) => ({
          name: r.kind === "action" ? r.name : `${r.team}/${r.name}`,
          kind: r.kind,
          title: r.displayName,
          team: r.team,
          description: text(r.description, 300),
        })),
        note: "Actions can go in a cart together; a template is run on its own from the Catalog.",
      };
    },
  },
  {
    spec: {
      name: "describe_offering",
      description: "What an action needs and gives: its inputs (and the wiring type each needs), its outputs (and what each provides), its team.",
      parameters: { type: "object", required: ["name"], properties: { name: { type: "string", description: "The action's name, as find_offerings gave it." } } },
    },
    async run(state, args) {
      const name = text(args["name"], 253);
      const shared = (await runnables(state.caller)).find((r) => r.kind === "action" && r.name === name && r.shared);
      const product = shared ? await findRunnableProduct(name) : undefined;
      if (!product) return { error: `No action "${name}" shared with this person. Use find_offerings.` };
      const types = new Map((await listWiringTypes()).map((t) => [t.name, t]));
      const inputs = fieldsOf(product.inputSchema, "x-vennir-needs");
      return {
        name,
        title: product.displayName ?? name,
        team: product.teamName,
        description: text(product.description, 600),
        inputs: inputs.map((i) => ({ ...i, ...(i.wiringType ? { wiringTypeMeans: text(types.get(i.wiringType)?.description, 200) } : {}) })),
        outputs: fieldsOf(product.outputSchema, "x-vennir-provides"),
      };
    },
  },
  {
    spec: {
      name: "list_team_resources",
      description: "What a team has deployed: the resources its runs made, each with what it provides (its wiring types and values), what it uses and what uses it. Defaults to the person's team.",
      parameters: { type: "object", properties: { team: { type: "string" }, search: { type: "string", description: "A type, id or name to look for." } } },
    },
    async run(state, args) {
      const team = teamFor(state, args["team"]);
      const found = await listResources(state.caller, { team, query: text(args["search"], 200) || undefined });
      return {
        team,
        resources: found.slice(0, 40).map((r) => ({
          type: r.type,
          id: r.externalId,
          name: r.name,
          state: r.state,
          madeBy: r.product,
          run: r.executionId,
          provides: r.provides,
          uses: r.dependsOn.map((d) => `${d.type} ${d.externalId}`),
          usedBy: r.dependents.map((d) => `${d.type} ${d.externalId}`),
        })),
      };
    },
  },
  {
    spec: {
      name: "get_run",
      description: "A run's state, and each step's state, outputs and failure (with its team's help on what it means and what to do). The person must be able to see it.",
      parameters: { type: "object", required: ["executionId"], properties: { executionId: { type: "string" } } },
    },
    async run(state, args) {
      const id = text(args["executionId"], 64);
      if (!/^[0-9a-f-]{36}$/.test(id)) return { error: "A run's id is a UUID." };
      const run = await executionDetail(state.caller, id, state.log);
      return {
        state: run.state,
        name: run.name,
        teams: run.teams,
        submittedBy: run.submittedBy,
        createdAt: run.createdAt,
        steps: run.tasks.map((t) => ({ id: t.taskId, state: t.state, attempts: t.attemptCount, outputs: t.outputs, failure: t.failure, help: t.help })),
        link: `/runs/${id}`,
      };
    },
  },
  {
    spec: {
      name: "plan_order",
      description:
        "Plan a cart of actions for a team, as the order builder does: which steps are added because something needs them, what the team already has that could be used instead (choices), what's suggested, and what the person must fill in. Runs nothing.",
      parameters: {
        type: "object",
        required: ["actions"],
        properties: {
          team: { type: "string" },
          actions: { type: "array", items: { type: "string" }, description: "Actions' names, as find_offerings gave them." },
          choices: { type: "array", items: CHOICE, description: "Choices already made: plan again to see what's left." },
        },
      },
    },
    async run(state, args) {
      const team = teamFor(state, args["team"]);
      const actions = Array.isArray(args["actions"]) ? args["actions"].map((a) => text(a, 253)).filter(Boolean).slice(0, 20) : [];
      const plan = await previewOrder(state.caller, { team, actions, choices: choicesOf(args["choices"]) });
      return {
        team,
        steps: plan.steps.map((s) => ({ id: s.id, action: s.product, addedBecauseNeeded: s.added, inputs: s.inputs })),
        toChoose: plan.problems.map((p) => ({
          code: p.code,
          step: p.step,
          input: p.input,
          message: p.message,
          options: p.options.map(({ label, ...choice }) => ({ label: label ?? "", choice })),
        })),
        suggested: plan.suggestions,
      };
    },
  },
  {
    spec: {
      name: "propose_cart",
      description:
        "Put actions in a cart for the person: they open it, check it, make any choices left, fill in any values left and place the order themselves. Nothing is ordered by this. Use plan_order first. Pass the choices the person made (plan_order's options, as given) and the values they told you (by step id, then input); never invent a value they didn't give. Then say what's still theirs to choose and fill in.",
      parameters: {
        type: "object",
        required: ["actions"],
        properties: {
          team: { type: "string" },
          actions: { type: "array", items: { type: "string" } },
          choices: { type: "array", items: CHOICE },
          values: {
            type: "object",
            description: 'What the person said to fill in, by plan_order\'s step id, then input: {"ticket-2": {"title": "Printer jam"}}.',
            additionalProperties: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
          },
        },
      },
    },
    async run(state, args) {
      const team = teamFor(state, args["team"]);
      const actions = Array.isArray(args["actions"]) ? args["actions"].map((a) => text(a, 253)).filter(Boolean).slice(0, 20) : [];
      // Checked as the order builder checks it: shared with them, for their
      // team; a choice kept only where it's one the plan offered.
      const asked = choicesOf(args["choices"]);
      const plan = await previewOrder(state.caller, { team, actions, choices: asked });
      const offered = await previewOrder(state.caller, { team, actions, choices: [] });
      const same = (a: OrderChoice, b: OrderChoice) =>
        a.step === b.step && a.input === b.input && (a.resourceId ?? "") === (b.resourceId ?? "") && (a.addNew ?? false) === (b.addNew ?? false) && (a.fromStep ?? "") === (b.fromStep ?? "") && (a.fromOutput ?? "") === (b.fromOutput ?? "");
      const choices = asked.filter((c) => [...offered.problems, ...plan.problems].some((p) => p.options.some((o) => same(o, c))));
      const unset = new Map(plan.steps.map((s) => [s.id, new Set(Object.entries(s.inputs).filter(([, i]) => i.kind === "unset").map(([name]) => name))]));
      const values = valuesOf(args["values"], unset);
      state.cart = { team, actions, choices, values };
      return {
        proposed: state.cart,
        ...(choices.length < asked.length ? { ignoredChoices: asked.length - choices.length, why: "Not among plan_order's options." } : {}),
        stillToChoose: plan.problems.filter((p) => !choices.some((c) => c.step === p.step && c.input === p.input)).map((p) => ({ step: p.step, input: p.input })),
        note: "The person sees an Open in cart button with these filled in; they check it and place the order.",
      };
    },
  },
];

export const toolSpecs: ToolSpec[] = TOOLS.map((t) => t.spec);

/** Runs a tool the model asked for: its result, or what went wrong, for the model to read. */
export async function runTool(state: TurnState, name: string, rawArguments: string): Promise<{ result: unknown; ok: boolean }> {
  const tool = TOOLS.find((t) => t.spec.name === name);
  if (!tool) return { ok: false, result: { error: `No tool "${name}". The tools are ${TOOLS.map((t) => t.spec.name).join(", ")}.` } };
  let args: unknown;
  try {
    args = JSON.parse(rawArguments || "{}");
  } catch {
    return { ok: false, result: { error: "The arguments weren't JSON." } };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { ok: false, result: { error: "The arguments must be an object." } };
  try {
    return { ok: true, result: await tool.run(state, args as Record<string, unknown>) };
  } catch (error) {
    // A refusal (not shared, not their team) is the person's limit: said.
    // Anything else is logged in full and said only as a failure, as the
    // API's maskErrors does: it may carry a cluster's or database's details.
    if (error instanceof ApiError) return { ok: false, result: { error: error.message } };
    state.log.error({ event: "chat_tool_failed", tool: name, err: error }, "a chat tool failed");
    return { ok: false, result: { error: "That failed on the platform's side; say so, and don't guess what it would have said." } };
  }
}
