// SPDX-License-Identifier: MIT
/**
 * Templates: what a consumer runs, filling in only parameters (the logic
 * behind TemplateService). A template comes from its team's catalog
 * (dags/*.yaml of kind Template, applied by catalogSync.ts); each step names
 * an action as <team>/<product>.<action>. Running one builds the DAG here,
 * from the registered products, never from the caller: each step runs its
 * product's latest registered image, as the product's ServiceAccount, with
 * its action's own secrets (product.yaml's secretRefs), in its team's
 * namespace. The caller supplies parameters, checked against the template's
 * schema, and nothing else.
 *
 * Who may run what (decided 2026-10-21):
 *   - a template: members of its team, admins, and whoever its shareWith
 *     covers: everyone ("*"), or members of the teams it lists, who then
 *     run it on behalf of one of those teams (the run records which);
 *   - a step of another team's action: only when that action is shared with
 *     the template's team (vennir catalog checks too; this holds for hand-made
 *     products and changed sharing);
 *   - an action on its own, as a one-step template whose parameters are its
 *     inputs: as a template, by the action's shareWith.
 * The run then belongs to whoever ran it as well as to its steps' teams
 * (auth/access.ts): they may see, cancel, retry and rerun it. Everything
 * else is a submission's checks (core/executions.ts's submitChecked), but
 * team membership: identities, secrets, images, scans.
 */
import type { FastifyBaseLogger } from "fastify";
import { Code } from "@connectrpc/connect";
import { ApiError } from "../apiError.js";
import { ensureMayOrder } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import {
  findRunnableProduct,
  findRunnableTemplate,
  listRunnableProducts,
  listRunnableTemplates,
  type Product,
  type SubmittedExecution,
  type Team,
  catalogRepository,
  findTeamByName,
  listAllTeams,
} from "../db/queries.js";
import type { ProductExample, TargetRule, TemplateStep } from "../db/schema.js";
import { errorMessage, errorPath, schemaErrors, schemaProblem } from "../jsonSchema.js";
import { UNREGISTERED_SERVICE_ACCOUNT } from "../productPolicy.js";
import { allowedValues, targetInputs, targetProblems } from "../targets.js";
import { readinessOf, type ReadinessView } from "../readiness.js";
import { catalogLinks, githubBase } from "./catalogLinks.js";
import { CLEANUP_RUN, submitChecked } from "./executions.js";
import { ensureOrderRate } from "./orderRate.js";
import { ensureRunsHere, runsHere } from "./clouds.js";

export type TeamProduct = Product & { teamName: string };

/** Why a parameter schema can't be used, or null. */
export const parameterSchemaProblem = schemaProblem;

function checkParameters(schema: unknown, parameters: Record<string, unknown>, label: string): void {
  const errors = schemaErrors(schema, parameters);
  if (errors.length === 0) return;
  const problems = errors.map((e) => ({ field: "parameters" + errorPath(e), message: errorMessage(e) }));
  throw new ApiError(
    422,
    "INVALID_PARAMETERS",
    `${label}: ${problems.map((p) => `${p.field} ${p.message}`).join("; ")}.`,
    undefined,
    { problems },
  );
}

/** Whether the caller may run something of `ownerTeam` shared with `shareWith`, and for which of their teams. */
interface Access {
  allowed: boolean;
  /** The caller's teams it may run on behalf of. */
  onBehalfOf: string[];
  /** Shared with specific teams only: a run names one of them. */
  required: boolean;
}

function access(caller: AuthUser, ownerTeam: string, shareWith: string[]): Access {
  const mine = caller.teamNames;
  if (caller.isAdmin || mine.includes(ownerTeam) || shareWith.includes("*")) {
    return { allowed: true, onBehalfOf: mine, required: false };
  }
  const eligible = mine.filter((team) => shareWith.includes(team));
  return { allowed: eligible.length > 0, onBehalfOf: eligible, required: true };
}

/** The team a run is on behalf of: the one asked for, if it may be; the only choice; or none. */
function onBehalfOf(allowed: Access, requested: string | undefined, label: string): string | undefined {
  if (requested) {
    if (!allowed.onBehalfOf.includes(requested)) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        allowed.required
          ? `${label} isn't shared with team "${requested}", or you aren't in it.`
          : `You aren't a member of team "${requested}".`,
      );
    }
    return requested;
  }
  if (!allowed.required) return undefined;
  if (allowed.onBehalfOf.length === 1) return allowed.onBehalfOf[0];
  throw new ApiError(
    422,
    "ON_BEHALF_OF_REQUIRED",
    `${label} is shared with specific teams: say which of yours it runs for (${allowed.onBehalfOf.join(", ")}).`,
  );
}

/** <team>/<product>.<action>, for a product registered from a catalog (named <team>-<product>-<action>). */
export function actionRef(product: TeamProduct): string {
  const prefix = `${product.teamName}-`;
  const suffix = `-${product.action}`;
  const productName =
    product.name.startsWith(prefix) && product.name.endsWith(suffix) && product.name.length > prefix.length + suffix.length
      ? product.name.slice(prefix.length, -suffix.length)
      : product.name;
  return `${product.teamName}/${productName}.${product.action}`;
}

const ACTION_REF = /^([a-z0-9-]+)\/([a-z0-9-]+)\.([a-z0-9-]+)$/;

/** The registered product an action reference names, if its team can run it. */
async function productFor(ref: string): Promise<TeamProduct | undefined> {
  const match = ACTION_REF.exec(ref);
  if (!match) return undefined;
  const [, team = "", product = "", action = ""] = match;
  const matches = (p: TeamProduct | undefined) => p && p.teamName === team && p.action === action;
  const conventional = await findRunnableProduct(`${team}-${product}-${action}`);
  if (matches(conventional)) return conventional;
  const named = await findRunnableProduct(product);
  return matches(named) ? named : undefined;
}

/** A step's product, which must be shared with the template's team when it's another team's. */
async function stepProduct(step: Pick<TemplateStep, "id" | "action">, templateTeam: string, label: string): Promise<TeamProduct> {
  const product = await productFor(step.action);
  if (!product) {
    throw new ApiError(
      422,
      "STEP_UNAVAILABLE",
      `${label}: step "${step.id}" runs ${step.action}, which isn't registered here (or its team is retired).`,
    );
  }
  if (product.teamName !== templateTeam && !product.shareWith.includes("*") && !product.shareWith.includes(templateTeam)) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      `${label}: step "${step.id}" runs ${step.action}, which team "${product.teamName}" doesn't share with team "${templateTeam}".`,
    );
  }
  return product;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A step's inputs with its parameters filled in ({$param: name}; one the
 * caller left out leaves its input out), and its upstream references in the
 * kernel's form ({$fromStep, $output} becomes {$fromTask, $output}, only as
 * an input's whole value). The kernel resolves {$fromTask, $output} at any
 * depth (kernel/internal/domain/task.go), so one written by hand deeper in
 * an input is resolved too: kernel-api still refuses one that names a step
 * this one doesn't depend on, and the target checks (targets.ts) refuse a
 * target input whose value isn't a string.
 */
function bind(inputs: Record<string, unknown> | undefined, parameters: Record<string, unknown>): Record<string, unknown> {
  const value = (v: unknown, top: boolean): unknown => {
    if (Array.isArray(v)) return v.map((item) => value(item, false)).filter((item) => item !== undefined);
    if (!isRecord(v)) return v;
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "$param") return parameters[String(v["$param"])];
    if (top && keys.length === 2 && "$fromStep" in v && "$output" in v) return { $fromTask: v["$fromStep"], $output: v["$output"] };
    return Object.fromEntries(
      Object.entries(v)
        .map(([k, item]) => [k, value(item, false)] as const)
        .filter(([, item]) => item !== undefined),
    );
  };
  return Object.fromEntries(
    Object.entries(inputs ?? {})
      .map(([k, v]) => [k, value(v, true)] as const)
      .filter(([, v]) => v !== undefined),
  );
}

interface ResolvedStep {
  step: TemplateStep;
  product: TeamProduct;
  inputs: Record<string, unknown>;
}

/**
 * Refuses a run that aims a product's target inputs (targets.ts) somewhere
 * its team doesn't let the run's team, before anything runs (X1). The run's
 * team is the one it's for, else any of the caller's. The owning team's own
 * people, and admins, aren't limited. Each problem names the parameter that
 * supplied the value when there is one.
 */
async function ensureTargetsAllowed(who: AuthUser, forTeam: string | undefined, steps: ResolvedStep[], label: string): Promise<void> {
  if (who.isAdmin) return;
  const teams = forTeam ? [forTeam] : who.teamNames;
  const owners = new Map<string, Team | undefined>();
  const problems: { field: string; message: string }[] = [];
  for (const { step, product, inputs } of steps) {
    if (who.teamNames.includes(product.teamName)) continue;
    if (!owners.has(product.teamName)) owners.set(product.teamName, await findTeamByName(product.teamName));
    const owner = owners.get(product.teamName);
    if (!owner) continue;
    for (const problem of targetProblems(owner, product.inputSchema, inputs, teams)) {
      const source = step.inputs?.[problem.field];
      const parameter = isRecord(source) && typeof source["$param"] === "string" ? source["$param"] : undefined;
      const field = parameter
        ? `parameters.${parameter}`
        : step.inputs === undefined
          ? `parameters.${problem.field}`
          : `steps.${step.id}.inputs.${problem.field}`;
      problems.push({ field, message: problem.message });
    }
  }
  if (problems.length === 0) return;
  throw new ApiError(403, "TARGET_NOT_ALLOWED", `${label}: ${problems.map((p) => p.message).join(" ")}`, undefined, { problems });
}

/** A runnable's parameters that name targets, with what the caller's teams may give each (X1). */
export interface TargetChoice {
  parameter: string;
  type: string;
  /** Values or patterns ("*" matches any run of characters); empty: none. */
  allowed: string[];
}

function targetChoices(
  who: AuthUser,
  steps: { inputs?: Record<string, unknown> | undefined; product: { teamName: string; inputSchema: unknown } }[],
  rulesOf: (team: string) => TargetRule[],
): TargetChoice[] {
  if (who.isAdmin) return [];
  const choices = new Map<string, TargetChoice>();
  for (const { inputs, product } of steps) {
    if (who.teamNames.includes(product.teamName)) continue;
    for (const [name, type] of targetInputs(product.inputSchema)) {
      const source = inputs === undefined ? { $param: name } : inputs[name];
      const parameter = isRecord(source) && typeof source["$param"] === "string" ? source["$param"] : undefined;
      if (!parameter) continue;
      choices.set(parameter, { parameter, type, allowed: allowedValues(rulesOf(product.teamName), who.teamNames, type) });
    }
  }
  return [...choices.values()];
}

/** The DAG the steps make: what core/executions.ts submits. */
function dagOf(name: string, steps: ResolvedStep[], requestId: string | undefined): Record<string, unknown> {
  return {
    name,
    ...(requestId ? { requestId } : {}),
    tasks: steps.map(({ step, product, inputs }) => ({
      id: step.id,
      image: product.image,
      action: product.action,
      team: product.teamName,
      serviceAccount: product.serviceAccount ?? UNREGISTERED_SERVICE_ACCOUNT,
      secretRefs: product.secretRefs,
      inputs,
      ...(step.dependsOn && step.dependsOn.length > 0 ? { dependsOn: step.dependsOn } : {}),
      ...(step.timeoutSeconds !== undefined ? { timeoutSeconds: step.timeoutSeconds } : {}),
      ...(step.maxAttempts !== undefined ? { maxAttempts: step.maxAttempts } : {}),
    })),
  };
}

export interface Runnable {
  kind: "template" | "action";
  team: string;
  name: string;
  displayName: string;
  description: string;
  parameters: unknown;
  actions: string[];
  deprecated: string | null;
  onBehalfOf: string[];
  onBehalfOfRequired: boolean;
  /** Whether the caller may run it; listed either way, unless hidden. */
  shared: boolean;
  shareWith: string[];
  /** Its file in the catalog repository, when known. */
  sourceUrl: string | null;
  /** Not shared: GitHub's new-issue page, filled in with what to change. */
  askForAccessUrl: string | null;
  /** Its parameters that name targets, and what the caller's teams may give them. */
  targets: TargetChoice[];
  /** Preview says what it would do: it (or a step of it) has a plan. */
  previewable: boolean;
  /** Whether it's ready here: its product's check, or its steps' together; null when none has one. */
  readiness: ReadinessView | null;
  /** Examples of running it: an action's passing contract tests, a template's own. */
  examples: ProductExample[];
  /** An action's product's clouds (empty for a template), and whether it's for this install. */
  clouds: string[];
  cloudsFrom: string;
  runsHere: boolean;
}

/** A template's clouds: those of its steps not for this install (none when every one is), and whether it runs here. */
function stepClouds(steps: string[][]): { clouds: string[]; cloudsFrom: string; runsHere: boolean } {
  const elsewhere = steps.filter((clouds) => !runsHere(clouds));
  return { clouds: [...new Set(elsewhere.flat())].sort(), cloudsFrom: "", runsHere: elsewhere.length === 0 };
}

function withClouds(clouds: ReturnType<typeof stepClouds>, readiness: ReadinessView | null) {
  return { ...clouds, readiness: clouds.runsHere ? readiness : null };
}

const READINESS_ORDER: (ReadinessView["state"])[] = ["not_ready", "failed", "checking", "unchecked", "ready"];

/** Several products' readiness as one: the worst of them, with everything missing. */
function together(views: ReadinessView[]): ReadinessView | null {
  if (views.length === 0) return null;
  const worst = [...views].sort((a, b) => READINESS_ORDER.indexOf(a.state) - READINESS_ORDER.indexOf(b.state))[0] ?? null;
  if (!worst || views.length === 1) return worst;
  return { ...worst, missing: [...new Set(views.flatMap((v) => v.missing))] };
}

/** Whether the caller sees something hidden: only its own team (and admins). */
function sees(caller: AuthUser, ownerTeam: string, hidden: boolean): boolean {
  return !hidden || caller.isAdmin || caller.teamNames.includes(ownerTeam);
}

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

/** The templates, and actions as one-step templates, the caller may see:
 * those they may run, and those they may ask for (all but hidden ones). */
export async function runnables(caller: AuthUser | undefined): Promise<Runnable[]> {
  const who = signedIn(caller);
  const base = githubBase(await catalogRepository());
  const rules = new Map((await listAllTeams()).map((team) => [team.name, team.allowedTargets]));
  const rulesOf = (team: string) => rules.get(team) ?? [];
  const products = await listRunnableProducts();
  const byRef = new Map(products.map((p) => [actionRef(p), p]));
  const names = new Set(products.map((p) => p.name));
  const ready = await readinessOf(products);
  // Its plan action is registered: <team>-<product>-<plan>.
  const hasPlan = (p: TeamProduct | undefined) =>
    Boolean(p?.plan && names.has(`${p.name.endsWith(`-${p.action}`) ? p.name.slice(0, -p.action.length - 1) : p.name}-${p.plan}`));
  const out: Runnable[] = [];
  for (const t of await listRunnableTemplates()) {
    if (!sees(who, t.teamName, t.hidden)) continue;
    const a = access(who, t.teamName, t.shareWith);
    out.push({
      kind: "template",
      team: t.teamName,
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      parameters: t.parameters,
      actions: t.steps.map((s) => s.action),
      deprecated: t.deprecated,
      onBehalfOf: a.onBehalfOf,
      onBehalfOfRequired: a.required,
      shared: a.allowed,
      shareWith: t.shareWith,
      ...catalogLinks(base, t.sourcePath, "the template", `${t.teamName}/${t.name}`, who, a.allowed),
      targets: targetChoices(
        who,
        t.steps.flatMap((s) => {
          const product = byRef.get(s.action);
          return product ? [{ inputs: s.inputs ?? {}, product }] : [];
        }),
        rulesOf,
      ),
      previewable: t.steps.some((step) => hasPlan(byRef.get(step.action))),
      examples: t.examples,
      // A step not for this install makes it not runnable here: the
      // clouds that step is for, so it's marked as an action would be,
      // with no readiness (its other steps' would say Ready).
      ...withClouds(
        stepClouds(t.steps.map((step) => byRef.get(step.action)?.clouds ?? [])),
        together(t.steps.flatMap((step) => {
          const view = ready.get(byRef.get(step.action)?.name ?? "");
          return view ? [view] : [];
        })),
      ),
    });
  }
  for (const p of products) {
    if (!sees(who, p.teamName, p.hidden)) continue;
    const a = access(who, p.teamName, p.shareWith);
    out.push({
      kind: "action",
      team: p.teamName,
      name: p.name,
      displayName: p.displayName ?? p.name,
      description: p.description ?? "",
      parameters: p.inputSchema,
      actions: [actionRef(p)],
      deprecated: p.deprecated,
      onBehalfOf: a.onBehalfOf,
      onBehalfOfRequired: a.required,
      shared: a.allowed,
      shareWith: p.shareWith,
      ...catalogLinks(base, p.sourcePath, "the action", actionRef(p), who, a.allowed),
      targets: targetChoices(who, [{ product: p }], rulesOf),
      previewable: hasPlan(p),
      readiness: ready.get(p.name) ?? null,
      examples: p.examples,
      clouds: p.clouds,
      cloudsFrom: p.cloudsFrom,
      runsHere: runsHere(p.clouds),
    });
  }
  return out;
}

export interface RunRequest {
  parameters: Record<string, unknown>;
  onBehalfOf?: string | undefined;
  requestId?: string | undefined;
}

/** Runs a template with these parameters. Not found and not shared look the same: 404. */
export async function runTemplate(
  caller: AuthUser | undefined,
  team: string,
  name: string,
  request: RunRequest,
  log: FastifyBaseLogger,
  scheduleId?: string,
) {
  const who = signedIn(caller);
  // An ordering bot orders only its listed templates (decision 23).
  ensureMayOrder(who, `${team}/${name}`);
  if (scheduleId === undefined) await ensureOrderRate(who);
  const { template, forTeam, steps } = await prepareTemplate(who, team, name, request);
  return submitChecked(who, dagOf(template.displayName, steps, request.requestId), log, {
    template: `${template.teamName}/${template.name}`,
    parameters: request.parameters,
    onBehalfOf: forTeam,
    scheduleId,
  });
}

/** Everything running a template checks, short of running it: its steps, for whom. Throws the refusal. */
async function prepareTemplate(who: AuthUser, team: string, name: string, request: RunRequest) {
  const template = await findRunnableTemplate(team, name);
  const allowed = template ? access(who, template.teamName, template.shareWith) : undefined;
  if (!template || !allowed?.allowed) {
    throw new ApiError(404, "NOT_FOUND", `No template "${team}/${name}" that's shared with you.`);
  }
  const label = `Template ${template.teamName}/${template.name}`;
  const forTeam = onBehalfOf(allowed, request.onBehalfOf, label);
  checkParameters(template.parameters, request.parameters, label);
  const steps: ResolvedStep[] = [];
  for (const step of template.steps) {
    const product = await stepProduct(step, template.teamName, label);
    // Before anything else is made for it (a schedule, a ServiceAccount).
    ensureRunsHere(product);
    steps.push({ step, product, inputs: bind(step.inputs, request.parameters) });
  }
  await ensureTargetsAllowed(who, forTeam, steps, label);
  return { template, forTeam, steps };
}

/**
 * Throws what running this template or action would refuse (not shared, a
 * parameter that doesn't fit, a target not allowed), without running it:
 * for a schedule, checked as its bot when it's made.
 */
export async function ensureRunnable(who: AuthUser, kind: "template" | "action", team: string, name: string, request: RunRequest): Promise<void> {
  if (kind === "template") await prepareTemplate(who, team, name, request);
  else await prepareAction(who, await findRunnableProduct(name), request, name);
}

/** What submitted_executions.template says for a preview run: never a template's <team>/<name>. */
export const PREVIEW_RUN = "preview";

/** What submitted_executions.template says for an order of a cart (core/orders.ts); its parameters are the cart. */
export const ORDER_RUN = "order";

/** One step of an order: a planned cart's action, its inputs (with {$fromTask} wiring), and what it waits for. */
export interface OrderRunStep {
  id: string;
  product: TeamProduct;
  inputs: Record<string, unknown>;
  dependsOn: string[];
}

/**
 * Runs a planned cart as one run for `forTeam` (decision 25): each step as
 * running its action alone would be (shared with the caller for that team,
 * its targets ones the team may use; its inputs known now checked at
 * submit, and wired ones, targets included, once the kernel resolves
 * them), wired between them. Nothing a raw DAG could add: the steps are
 * the registered products', with their own identities and secrets.
 */
export async function runOrderSteps(
  who: AuthUser,
  name: string,
  list: OrderRunStep[],
  forTeam: string,
  cart: Record<string, unknown>,
  requestId: string | undefined,
  log: FastifyBaseLogger,
) {
  for (const s of list) {
    const allowed = access(who, s.product.teamName, s.product.shareWith);
    if (!allowed.allowed || (allowed.required && !allowed.onBehalfOf.includes(forTeam))) {
      throw new ApiError(403, "FORBIDDEN", `Step ${s.id}: ${actionRef(s.product)} isn't shared with team "${forTeam}".`);
    }
  }
  const steps: ResolvedStep[] = list.map((s) => ({
    step: { id: s.id, action: actionRef(s.product), ...(s.dependsOn.length > 0 ? { dependsOn: s.dependsOn } : {}) },
    product: s.product,
    inputs: s.inputs,
  }));
  await ensureTargetsAllowed(who, forTeam, steps, name);
  return submitChecked(who, dagOf(name, steps, requestId), log, { template: ORDER_RUN, parameters: cart, onBehalfOf: forTeam });
}

/** One step of a run the console makes itself (a cleanup, a preview): a product's action, with its inputs. */
export interface ProductStep {
  id: string;
  product: TeamProduct;
  inputs: Record<string, unknown>;
  /** What it's for, in a refusal: "local/ticket T-1", "step deploy". */
  label: string;
}

/**
 * Runs product steps for a team of the caller's (or the caller alone), as a
 * template's run is: their inputs fit their schemas and their targets are
 * ones the caller may use; and, with `eachShared`, each action is shared
 * with the caller (a template's previews are allowed as the template is
 * instead). `chained`: one after another, in the order given; else side by
 * side.
 */
export async function runProductSteps(
  who: AuthUser,
  name: string,
  list: ProductStep[],
  forTeam: string | undefined,
  run: { template: string; parameters: Record<string, unknown>; forTeams?: Record<string, string> | undefined },
  options: { chained: boolean; eachShared: boolean },
  log: FastifyBaseLogger,
): Promise<{ executionId: string }> {
  const steps: ResolvedStep[] = list.map((s, i) => ({
    step: { id: s.id, action: actionRef(s.product), ...(options.chained && i > 0 ? { dependsOn: [list[i - 1]?.id ?? ""] } : {}) },
    product: s.product,
    inputs: s.inputs,
  }));
  for (const s of list) {
    if (options.eachShared) {
      const allowed = access(who, s.product.teamName, s.product.shareWith);
      if (!allowed.allowed || (allowed.required && (!forTeam || !allowed.onBehalfOf.includes(forTeam)))) {
        throw new ApiError(403, "FORBIDDEN", `${s.label}: ${actionRef(s.product)} isn't shared with you${forTeam ? ` for team "${forTeam}"` : ""}.`);
      }
    }
    checkParameters(s.product.inputSchema, s.inputs, `${s.label}: ${actionRef(s.product)}`);
  }
  await ensureTargetsAllowed(who, forTeam, steps, name);
  const result = await submitChecked(who, dagOf(name, steps, undefined), log, { ...run, onBehalfOf: forTeam });
  return { executionId: result.executionId };
}

/** Another action of the same product, as registered now (<team>-<product>-<action>). */
export async function siblingAction(product: TeamProduct, action: string): Promise<TeamProduct | undefined> {
  const suffix = `-${product.action}`;
  const base = product.name.endsWith(suffix) ? product.name.slice(0, -suffix.length) : product.name;
  const sibling = await findRunnableProduct(`${base}-${action}`);
  return sibling && sibling.teamName === product.teamName ? sibling : undefined;
}

/** Steps a preview couldn't include, and why. */
export interface NotPreviewed {
  step: string;
  why: string;
}

const noPreview = (label: string) =>
  new ApiError(409, "NO_PREVIEW", `${label} has no preview: its product.yaml names no plan for it.`);

/** Previews one action with these inputs: a run of its plan action. */
export async function previewAction(caller: AuthUser | undefined, productName: string, request: RunRequest, log: FastifyBaseLogger) {
  const who = signedIn(caller);
  ensureMayOrder(who);
  const product = await findRunnableProduct(productName);
  const allowed = product ? access(who, product.teamName, product.shareWith) : undefined;
  if (!product || !allowed?.allowed) throw new ApiError(404, "NOT_FOUND", `No action "${productName}" that's shared with you.`);
  const ref = actionRef(product);
  const forTeam = onBehalfOf(allowed, request.onBehalfOf, `Action ${ref}`);
  checkParameters(product.inputSchema, request.parameters, `Action ${ref}`);
  const plan = product.plan ? await siblingAction(product, product.plan) : undefined;
  if (!plan) throw noPreview(`Action ${ref}`);
  const { executionId } = await runProductSteps(
    who,
    `Preview: ${product.displayName ?? product.name}`,
    [{ id: product.action, product: plan, inputs: request.parameters, label: `Action ${ref}` }],
    forTeam,
    { template: PREVIEW_RUN, parameters: { of: ref, parameters: request.parameters } },
    { chained: false, eachShared: true },
    log,
  );
  return { executionId, notPreviewed: [] as NotPreviewed[] };
}

/**
 * Previews a template with these parameters: its steps' plan actions, side
 * by side, for the steps that have one and whose inputs are known now (not
 * an earlier step's output). Allowed as running the template is.
 */
export async function previewTemplate(caller: AuthUser | undefined, team: string, name: string, request: RunRequest, log: FastifyBaseLogger) {
  const who = signedIn(caller);
  ensureMayOrder(who, `${team}/${name}`);
  await ensureOrderRate(who);
  const template = await findRunnableTemplate(team, name);
  const allowed = template ? access(who, template.teamName, template.shareWith) : undefined;
  if (!template || !allowed?.allowed) throw new ApiError(404, "NOT_FOUND", `No template "${team}/${name}" that's shared with you.`);
  const label = `Template ${template.teamName}/${template.name}`;
  const forTeam = onBehalfOf(allowed, request.onBehalfOf, label);
  checkParameters(template.parameters, request.parameters, label);
  const planned: ProductStep[] = [];
  const notPreviewed: NotPreviewed[] = [];
  for (const step of template.steps) {
    const product = await stepProduct(step, template.teamName, label);
    const inputs = bind(step.inputs, request.parameters);
    const plan = product.plan ? await siblingAction(product, product.plan) : undefined;
    const upstream = Object.values(inputs).find((v): v is { $fromTask: string } => isRecord(v) && typeof v["$fromTask"] === "string");
    if (!plan) notPreviewed.push({ step: step.id, why: `${step.action} has no preview.` });
    else if (plan.teamName !== template.teamName && !plan.shareWith.includes("*") && !plan.shareWith.includes(template.teamName)) {
      notPreviewed.push({ step: step.id, why: `Its preview isn't shared with team "${template.teamName}".` });
    } else if (upstream) notPreviewed.push({ step: step.id, why: `It uses ${upstream.$fromTask}'s output, known only once that runs.` });
    else planned.push({ id: step.id, product: plan, inputs, label: `${label}: step "${step.id}"` });
  }
  if (planned.length === 0) throw new ApiError(409, "NO_PREVIEW", `${label}: none of its steps can be previewed. ${notPreviewed.map((n) => `${n.step}: ${n.why}`).join(" ")}`);
  const { executionId } = await runProductSteps(
    who,
    `Preview: ${template.displayName}`,
    planned,
    forTeam,
    { template: PREVIEW_RUN, parameters: { of: `${template.teamName}/${template.name}`, parameters: request.parameters } },
    { chained: false, eachShared: false },
    log,
  );
  return { executionId, notPreviewed };
}

/**
 * Runs cleanup steps one after another, newest first (core/resources.ts):
 * for `forTeam` (the caller's, or none), and each step for its `madeFor`,
 * the team what it deletes was made for, so its product deletes only that
 * team's.
 */
export async function runCleanup(
  who: AuthUser,
  name: string,
  cleanups: (Omit<ProductStep, "id"> & { madeFor: string })[],
  forTeam: string | undefined,
  resourceIds: string[],
  log: FastifyBaseLogger,
): Promise<{ executionId: string; stepIds: string[] }> {
  const list = cleanups.map((c, i) => ({ id: `delete-${String(i + 1)}`, product: c.product, inputs: c.inputs, label: c.label }));
  const forTeams = Object.fromEntries(cleanups.map((c, i) => [list[i]?.id ?? "", c.madeFor] as const).filter(([, team]) => team !== ""));
  const { executionId } = await runProductSteps(
    who,
    name,
    list,
    forTeam,
    { template: CLEANUP_RUN, parameters: { resources: resourceIds }, forTeams },
    { chained: true, eachShared: true },
    log,
  );
  return { executionId, stepIds: list.map((s) => s.id) };
}

/** Runs one action with these inputs, as a one-step template. */
export async function runAction(caller: AuthUser | undefined, productName: string, request: RunRequest, log: FastifyBaseLogger, scheduleId?: string) {
  const who = signedIn(caller);
  ensureMayOrder(who);
  const product = await findRunnableProduct(productName);
  return runProduct(who, product, request, log, productName, scheduleId);
}

async function runProduct(
  who: AuthUser,
  product: TeamProduct | undefined,
  request: RunRequest,
  log: FastifyBaseLogger,
  label: string,
  scheduleId?: string,
) {
  const { found, ref, forTeam, step } = await prepareAction(who, product, request, label);
  return submitChecked(
    who,
    dagOf(found.displayName ?? found.name, [{ step, product: found, inputs: request.parameters }], request.requestId),
    log,
    { template: ref, parameters: request.parameters, onBehalfOf: forTeam, scheduleId },
  );
}

/** Everything running an action alone checks, short of running it. Throws the refusal. */
async function prepareAction(who: AuthUser, product: TeamProduct | undefined, request: RunRequest, label: string) {
  const allowed = product ? access(who, product.teamName, product.shareWith) : undefined;
  if (!product || !allowed?.allowed) {
    throw new ApiError(404, "NOT_FOUND", `No action "${label}" that's shared with you.`);
  }
  const ref = actionRef(product);
  const forTeam = onBehalfOf(allowed, request.onBehalfOf, `Action ${ref}`);
  checkParameters(product.inputSchema, request.parameters, `Action ${ref}`);
  ensureRunsHere(product);
  const step: TemplateStep = { id: product.action, action: ref };
  await ensureTargetsAllowed(who, forTeam, [{ step, product, inputs: request.parameters }], `Action ${ref}`);
  return { found: product, ref, forTeam, step };
}

/**
 * Reruns a template's run: the template (or action) as it is now, with the
 * same parameters, for the same team, as whoever reruns it, who must be
 * allowed to run it now. Its steps use their products' current images.
 */
/**
 * Why a template's steps can't run for its team now, one problem per step:
 * an action that isn't registered here, or another team's that isn't
 * shared with the template's team (X2: a step's team consents through its
 * shareWith). Checked when a release is applied, before the template is
 * stored, and again on every run.
 */
export async function templateStepProblems(
  team: string,
  name: string,
  steps: Pick<TemplateStep, "id" | "action">[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const step of steps) {
    try {
      await stepProduct(step, team, `Template ${team}/${name}`);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      problems.push(error.message);
    }
  }
  return problems;
}

/**
 * Refuses retrying a consumer's own template or action run once it couldn't
 * be run any more: no longer shared with them, gone, or a step's action no
 * longer shared with the template's team. Retrying runs those steps again,
 * so it needs the same consent as running them did.
 */
export async function ensureStillRunnable(caller: AuthUser | undefined, submitted: SubmittedExecution): Promise<void> {
  const who = signedIn(caller);
  const ref = submitted.template ?? "";
  // A cleanup's steps were allowed when it was asked for; retrying one
  // deletes the same thing again, which cleanup actions must allow.
  if (ref === CLEANUP_RUN || ref === PREVIEW_RUN) return;
  // And still theirs to run for the team it was for: one of the teams they
  // could name running it now, as running it again checks (onBehalfOf). A
  // run for nobody's team was their own.
  const forTeam = submitted.onBehalfOf;
  const still = (allowed: Access) => allowed.allowed && (!forTeam || who.isAdmin || allowed.onBehalfOf.includes(forTeam));
  const left = () =>
    new ApiError(403, "FORBIDDEN", `This run was for team "${forTeam ?? ""}", which you aren't in any more (or it isn't shared with it any more), so it isn't yours to retry: a maintainer of its teams can.`);
  const inTeam = !forTeam || who.isAdmin || who.teamNames.includes(forTeam);
  if (!inTeam) throw left();
  if (ref === ORDER_RUN) {
    // Each of its actions still shared with the caller: as placing it was.
    const actions = isRecord(submitted.templateParameters) && Array.isArray(submitted.templateParameters["actions"]) ? submitted.templateParameters["actions"] : [];
    for (const name of actions) {
      const product = typeof name === "string" ? await findRunnableProduct(name) : undefined;
      if (!product || !still(access(who, product.teamName, product.shareWith))) {
        throw new ApiError(403, "FORBIDDEN", `${String(name)} isn't shared with you any more, so this order can't be retried.`);
      }
    }
    return;
  }
  const refused = (why: string) =>
    new ApiError(403, "FORBIDDEN", `${ref} ${why}, so this run can't be retried. Its team can share it again.`);
  if (ACTION_REF.test(ref)) {
    const product = await productFor(ref);
    if (!product || !still(access(who, product.teamName, product.shareWith))) throw refused("isn't shared with you any more");
    return;
  }
  const [team = "", name = ""] = ref.split("/");
  const template = await findRunnableTemplate(team, name);
  if (!template || !still(access(who, template.teamName, template.shareWith))) throw refused("isn't shared with you any more");
  const problems = await templateStepProblems(template.teamName, template.name, template.steps);
  if (problems.length > 0) throw new ApiError(403, "FORBIDDEN", `${problems.join(" ")} This run can't be retried.`);
}

export async function rerunTemplate(caller: AuthUser | undefined, submitted: SubmittedExecution, log: FastifyBaseLogger) {
  const who = signedIn(caller);
  const ref = submitted.template ?? "";
  if (ref === CLEANUP_RUN) {
    throw new ApiError(409, "CLEANUP_RUN", "A cleanup run isn't run again: delete what's still there from the resources it was for.");
  }
  if (ref === PREVIEW_RUN) throw new ApiError(409, "PREVIEW_RUN", "A preview isn't run again: preview from the form.");
  if (ref === ORDER_RUN) {
    // The same cart, planned again against the catalog as it is now.
    const { placeOrder, cartOf } = await import("./orders.js");
    return placeOrder(who, { ...cartOf(submitted.templateParameters, submitted.onBehalfOf ?? ""), requestId: undefined }, log);
  }
  const request: RunRequest = {
    parameters: isRecord(submitted.templateParameters) ? submitted.templateParameters : {},
    onBehalfOf: submitted.onBehalfOf ?? undefined,
  };
  if (ACTION_REF.test(ref)) return runProduct(who, await productFor(ref), request, log, ref);
  const [team = "", name = ""] = ref.split("/");
  return runTemplate(who, team, name, request, log);
}
