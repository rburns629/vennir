// SPDX-License-Identifier: MIT
/**
 * Whether each product is ready on this install: its check action
 * (product.yaml's check), run by the console itself as a run of its own (a
 * check run), as the product's identity with its secrets, in its team's
 * namespace, with no inputs. It answers {ready, principal, missing, detail}
 * (who it acts as here, and what it lacks), kept in product_readiness and
 * shown with the product.
 *
 * Every five minutes, a product is checked when it's new, its image
 * changed, its last answer is a day old, or someone asked (Check now); a
 * check run lost for an hour is tried again. Each is claimed with one
 * conditional write, so two consoles never check the same one twice.
 * resourceRecorder.ts hands the finished run to recordCheck. A product
 * found not ready tells its team's maintainers and admins, once per image
 * and set of what's missing.
 */
import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ApiError } from "./apiError.js";
import { submitChecked } from "./core/executions.js";
import { db } from "./db/client.js";
import { listRunnableProducts, type Product } from "./db/queries.js";
import { productReadiness, teamMemberships, teams, users, type ReadinessState } from "./db/schema.js";
import type { KernelExecution } from "./kernel/client.js";
import { notify } from "./notifier.js";
import { UNREGISTERED_SERVICE_ACCOUNT } from "./productPolicy.js";
import { runsHere } from "./core/clouds.js";

/** What submitted_executions.template says for a check run: never a template's <team>/<name>. */
export const CHECK_RUN = "check";
const TASK = "check";

type TeamProduct = Product & { teamName: string };

/** Each product's check action, as registered now: <team>-<product>-<check>. */
function checkActions(products: TeamProduct[]): TeamProduct[] {
  const byName = new Map(products.map((p) => [p.name, p]));
  const out = new Map<string, TeamProduct>();
  for (const p of products) {
    const name = checkName(p);
    const check = name ? byName.get(name) : undefined;
    // Not for this install's cloud: never checked here (core/clouds.ts).
    if (check && check.teamName === p.teamName && runsHere(check.clouds)) out.set(check.name, check);
  }
  return [...out.values()];
}

/** Claims a check of this one when it's due (or `now`), in one write; returns whether this console got it. */
async function claim(check: TeamProduct, now: boolean): Promise<boolean> {
  const due = now
    ? sql`${productReadiness.state} <> 'checking' OR ${productReadiness.requestedAt} < now() - interval '5 minutes'`
    : sql`${productReadiness.image} <> ${check.image}
        OR (${productReadiness.state} <> 'checking' AND coalesce(${productReadiness.checkedAt}, 'epoch') < now() - interval '1 day')
        OR (${productReadiness.state} = 'checking' AND ${productReadiness.requestedAt} < now() - interval '1 hour')`;
  const claimed = await db
    .insert(productReadiness)
    .values({ product: check.name, productTeam: check.teamName, image: check.image, state: "checking" })
    .onConflictDoUpdate({
      target: productReadiness.product,
      set: { state: "checking", image: check.image, executionId: null, requestedAt: sql`now()` },
      setWhere: due,
    })
    .returning({ product: productReadiness.product });
  return claimed.length > 0;
}

/** Runs a product's check now, as the console. */
async function submit(check: TeamProduct, log: FastifyBaseLogger): Promise<void> {
  try {
    const { executionId } = await submitChecked(
      undefined,
      {
        name: `Check: ${check.displayName ?? check.name}`,
        tasks: [
          {
            id: TASK,
            image: check.image,
            action: check.action,
            team: check.teamName,
            serviceAccount: check.serviceAccount ?? UNREGISTERED_SERVICE_ACCOUNT,
            secretRefs: check.secretRefs,
            inputs: {},
          },
        ],
      },
      log,
      { template: CHECK_RUN, parameters: { product: check.name }, onBehalfOf: undefined },
    );
    await db.update(productReadiness).set({ executionId }).where(eq(productReadiness.product, check.name));
  } catch (error) {
    // Refused before it ran (its team retired, its image not allowed): that's
    // the answer. Anything else (a cluster or kernel-api error, whose message
    // can carry the API server's response) is only logged: detail is shown
    // to everyone signed in.
    const why = error instanceof ApiError ? error.message : "Vennir couldn't start its check: the platform didn't answer.";
    await db
      .update(productReadiness)
      .set({ state: "failed", detail: why.slice(0, 1000), checkedAt: sql`now()` })
      .where(eq(productReadiness.product, check.name));
    log.warn({ event: "readiness_check_refused", product: check.name, err: error }, "couldn't run a product's check");
  }
}

/** One pass: every product's check that's due. */
export async function checkDue(log: FastifyBaseLogger): Promise<number> {
  let started = 0;
  for (const check of checkActions(await listRunnableProducts())) {
    if (await claim(check, false)) {
      await submit(check, log);
      started += 1;
    }
  }
  return started;
}

/** Checks a product now (Check now), given any action of it. Returns false when it has no check, or one is already under way. */
export async function checkNow(product: TeamProduct, log: FastifyBaseLogger): Promise<boolean> {
  const [check] = checkActions([product, ...(await listRunnableProducts()).filter((p) => p.teamName === product.teamName)]).filter(
    (c) => c.name === checkName(product),
  );
  if (!check || !(await claim(check, true))) return false;
  await submit(check, log);
  return true;
}

/** The registered name of a product's check action: <team>-<product>-<check>. */
function checkName(p: { name: string; action: string; check: string | null }): string | null {
  if (!p.check) return null;
  const base = p.name.endsWith(`-${p.action}`) ? p.name.slice(0, -p.action.length - 1) : p.name;
  return `${base}-${p.check}`;
}

export interface ReadinessView {
  state: ReadinessState | "unchecked";
  principal: string | null;
  missing: string[];
  detail: string | null;
  checkedAt: Date | null;
  executionId: string | null;
}

/** Each of these products' readiness, by its name; a product with no check isn't in it. */
export async function readinessOf(products: { name: string; action: string; check: string | null; clouds: string[] }[]): Promise<Map<string, ReadinessView>> {
  const rows = new Map((await db.select().from(productReadiness)).map((r) => [r.product, r]));
  const out = new Map<string, ReadinessView>();
  for (const p of products) {
    const name = checkName(p);
    // Not for this install: no readiness here, not even an old answer.
    if (!name || !runsHere(p.clouds)) continue;
    const row = rows.get(name);
    out.set(p.name, {
      state: row?.state ?? "unchecked",
      principal: row?.principal ?? null,
      missing: row?.missing ?? [],
      detail: row?.detail ?? null,
      checkedAt: row?.checkedAt ?? null,
      executionId: row?.executionId ?? null,
    });
  }
  return out;
}

const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.length > 0 ? value.slice(0, max) : null);

/** A finished check run's answer (resourceRecorder.ts calls this). */
export async function recordCheck(executionId: string, detail: KernelExecution): Promise<void> {
  const [row] = await db.select().from(productReadiness).where(eq(productReadiness.executionId, executionId));
  if (!row) return;
  const task = detail.tasks.find((t) => t.taskId === TASK);
  const outputs = (task?.outputs ?? {}) as Record<string, unknown>;
  const answered = task?.state === "SUCCEEDED" && typeof outputs["ready"] === "boolean";
  const missing = Array.isArray(outputs["missing"])
    ? (outputs["missing"] as unknown[]).flatMap((m) => (typeof m === "string" && m ? [m.slice(0, 300)] : [])).slice(0, 20)
    : [];
  const state: ReadinessState = !answered ? "failed" : outputs["ready"] === true ? "ready" : "not_ready";
  const failure = task?.failure;
  const why = !answered
    ? (text(failure?.["message"], 1000) ?? text(failure?.["code"], 100) ?? "Its check didn't say whether it's ready.")
    : text(outputs["detail"], 1000);
  await db
    .update(productReadiness)
    .set({ state, principal: answered ? text(outputs["principal"], 300) : row.principal, missing, detail: why, checkedAt: sql`now()` })
    .where(and(eq(productReadiness.product, row.product), eq(productReadiness.executionId, executionId)));
  if (state === "not_ready") await notifyNotReady(row.product, row.productTeam, row.image, missing);
}

async function notifyNotReady(product: string, team: string, image: string, missing: string[]): Promise<void> {
  const [teamRow] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.name, team), isNull(teams.deletedAt)));
  const maintainers = teamRow
    ? await db.select({ id: teamMemberships.userId }).from(teamMemberships).where(and(eq(teamMemberships.teamId, teamRow.id), eq(teamMemberships.role, "maintainer")))
    : [];
  const admins = await db.select({ id: users.id }).from(users).where(and(eq(users.isAdmin, true), eq(users.isBot, false)));
  const humans = await db.select({ id: users.id }).from(users).where(eq(users.isBot, false));
  const human = new Set(humans.map((h) => h.id));
  await notify({
    key: `ready:${product}:${image}:${missing.join("|")}`,
    kind: "product_not_ready",
    title: `${product} isn't ready on this install`,
    body: missing.length > 0 ? `Missing: ${missing.join("; ")}.` : "",
    link: "/products",
    userIds: [...maintainers, ...admins].map((u) => u.id).filter((id) => human.has(id)),
    teams: [team],
  });
}

export function startReadiness(log: FastifyBaseLogger): void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    checkDue(log)
      .then((started) => {
        if (started > 0) log.info({ event: "readiness_checks", started }, "started products' readiness checks");
      })
      .catch((error: unknown) => {
        log.error({ err: error }, "couldn't start products' readiness checks");
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  setInterval(run, 5 * 60_000).unref();
}
