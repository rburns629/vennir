// SPDX-License-Identifier: MIT
/**
 * What finished runs made (decision 21, docs/assessment.md): every 30
 * seconds, the runs not yet looked at that have finished have the
 * resources their succeeded steps reported (`resources: [{type, id, name,
 * link}]` in their outputs) copied into the resources table, with each
 * step's resolved inputs and outputs, so a resource can be deleted after
 * its run is gone. A run that ran a delete (core/resources.ts) marks what it
 * deleted. A retried run is recorded again once it finishes. A run the kernel no longer has
 * is passed over. A failed pass is logged and the next one tries again:
 * nothing is marked recorded until it is. Each resource also keeps what
 * its step provided (each output typed x-vertra-provides) and links to the
 * resources its step took inputs from (resourceLinks: an input wired from
 * another step of the run, or one whose value a live resource provides, of
 * the input's wiring type), decision 25. Each finished run is also told to
 * notifier.ts, which says so to whoever ran it, and to callbacks.ts, which
 * posts it to its ordering bot's callback and its teams' outcome webhooks.
 */
import type { FastifyBaseLogger } from "fastify";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { productLookup, productOfTask } from "./core/executions.js";
import { db } from "./db/client.js";
import { products, resourceDeleteRequests, resourceLinks, resources, submittedExecutions, type Provided } from "./db/schema.js";
import { getExecution, getExecutionStates, type KernelExecution } from "./kernel/client.js";
import { runFinished } from "./notifier.js";
import { runFinishedCallbacks } from "./callbacks.js";
import { recordCheck } from "./readiness.js";

const FINISHED = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
/** Runs looked at, and finished ones read in full, per pass. */
const PER_PASS = 500;
const READ_PER_PASS = 50;
const MAX_PER_STEP = 100;

export interface Reported {
  type: string;
  id: string;
  name: string | null;
  link: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);

/**
 * The resources a step's outputs report. They come from a product's
 * container, so each is checked: a type and an id, an optional name, an
 * optional http(s) link; anything else is left out, as are any past the
 * first hundred.
 */
export function reportedResources(outputs: Record<string, unknown> | null): Reported[] {
  const list = outputs?.["resources"];
  if (!Array.isArray(list)) return [];
  const out: Reported[] = [];
  for (const item of list.slice(0, MAX_PER_STEP)) {
    if (!isRecord(item)) continue;
    const type = text(item["type"], 128);
    const id = text(item["id"], 512);
    if (!type || !id) continue;
    const link = text(item["link"], 2048);
    out.push({ type, id, name: text(item["name"], 256), link: link && /^https?:\/\//.test(link) ? link : null });
  }
  return out;
}

/** A task's inputs with each {$fromTask, $output} replaced by that output, as the kernel resolved them. */
export function resolvedInputs(inputs: unknown, outputs: Map<string, Record<string, unknown>>): Record<string, unknown> {
  if (!isRecord(inputs)) return {};
  return Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => {
      if (isRecord(value) && typeof value["$fromTask"] === "string" && typeof value["$output"] === "string" && Object.keys(value).length === 2) {
        return [name, outputs.get(value["$fromTask"])?.[value["$output"]] ?? null];
      }
      return [name, value];
    }),
  );
}

/** A schema's top-level property `name`'s wiring hint (x-vertra-needs or x-vertra-provides), or null. */
function hintOf(schema: unknown, name: string, hint: "x-vertra-needs" | "x-vertra-provides"): string | null {
  const properties = isRecord(schema) && isRecord(schema["properties"]) ? schema["properties"] : {};
  const property = properties[name];
  const wiring = isRecord(property) ? property[hint] : undefined;
  return typeof wiring === "string" && wiring.length > 0 ? wiring : null;
}

/** A wiring type's value as provides keeps it: a scalar, as text; anything else isn't one. */
function scalar(value: unknown): string | null {
  return typeof value === "string" ? text(value, 2048) : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

/** What a step provided: each of its outputs its product types with x-vertra-provides, with a scalar value. */
export function providedBy(outputSchema: unknown, outputs: Record<string, unknown>): Provided[] {
  return Object.entries(outputs).flatMap(([output, raw]) => {
    const type = hintOf(outputSchema, output, "x-vertra-provides");
    const value = scalar(raw);
    return type && value !== null ? [{ type, value, output }] : [];
  });
}

/**
 * Brings what a product's live resources provide up to its output schema:
 * a product that types an output later (or stops) has its resources made
 * before then offered by that type too, from the outputs kept with each.
 * What newly provides a value is linked to the live resources that took
 * that value as an input needing its type, as the recorder would have
 * (links aren't removed when a type is: a step wired in its run still
 * depends on what it was wired from). Only rows that change are written.
 * How many changed.
 */
export async function refreshProvides(product: string, outputSchema: unknown): Promise<number> {
  const live = await db
    .select({ id: resources.id, outputs: resources.outputs, provides: resources.provides })
    .from(resources)
    .where(and(eq(resources.product, product), isNull(resources.deletedAt)));
  let changed = 0;
  let needers: { product: string; input: string; wiringType: string }[] | null = null;
  for (const r of live) {
    const provides = providedBy(outputSchema, isRecord(r.outputs) ? r.outputs : {});
    if (JSON.stringify(provides) === JSON.stringify(r.provides)) continue;
    await db.update(resources).set({ provides }).where(eq(resources.id, r.id));
    changed += 1;
    const gained = provides.filter((p) => !r.provides.some((q) => q.type === p.type && q.value === p.value));
    if (gained.length === 0) continue;
    // The registered actions with an input that needs a type, read once.
    needers ??= (await db.select({ name: products.name, inputSchema: products.inputSchema }).from(products)).flatMap((p) => {
      const properties = isRecord(p.inputSchema) && isRecord(p.inputSchema["properties"]) ? p.inputSchema["properties"] : {};
      return Object.keys(properties).flatMap((input) => {
        const wiringType = hintOf(p.inputSchema, input, "x-vertra-needs");
        return wiringType ? [{ product: p.name, input, wiringType }] : [];
      });
    });
    for (const { type, value } of gained) {
      for (const n of needers.filter((x) => x.wiringType === type)) {
        const using = await db
          .select({ id: resources.id })
          .from(resources)
          .where(and(eq(resources.product, n.product), isNull(resources.deletedAt), ne(resources.id, r.id), sql`${resources.inputs} @> ${JSON.stringify({ [n.input]: value })}::jsonb`));
        if (using.length > 0) {
          await db
            .insert(resourceLinks)
            .values(using.map((u) => ({ resourceId: u.id, dependsOnId: r.id, input: n.input, wiringType: type })))
            .onConflictDoNothing();
        }
      }
    }
  }
  return changed;
}

const isReference = (value: unknown): value is { $fromTask: string; $output: string } =>
  isRecord(value) && typeof value["$fromTask"] === "string" && typeof value["$output"] === "string" && Object.keys(value).length === 2;

/** Each task's place in its run: after everything it depends on. */
function positions(tasks: Record<string, unknown>[]): Map<string, number> {
  const order = new Map<string, number>();
  const pending = [...tasks];
  while (pending.length > 0) {
    const ready = pending.findIndex((t) =>
      (Array.isArray(t["dependsOn"]) ? t["dependsOn"] : []).every((d: unknown) => typeof d !== "string" || order.has(d) || !tasks.some((x) => x["id"] === d)),
    );
    const [task] = pending.splice(ready === -1 ? 0 : ready, 1);
    if (task && typeof task["id"] === "string") order.set(task["id"], order.size);
  }
  return order;
}

type Run = Pick<typeof submittedExecutions.$inferSelect, "executionId" | "submittedBy" | "payload" | "template" | "onBehalfOf">;

/** Copies one finished run's resources, marks what its deletes removed, and marks it recorded. */
export async function recordRun(run: Run, detail: KernelExecution): Promise<number> {
  const tasks = isRecord(run.payload) && Array.isArray(run.payload["tasks"]) ? run.payload["tasks"].filter(isRecord) : [];
  const outputs = new Map(detail.tasks.flatMap((t) => (t.outputs ? [[t.taskId, t.outputs as Record<string, unknown>] as const] : [])));
  const state = new Map(detail.tasks.map((t) => [t.taskId, t.state]));
  const order = positions(tasks);
  const products = productLookup();
  const rows: (typeof resources.$inferInsert)[] = [];
  // The steps that reported something: their tasks and products, for links.
  const reporters = new Map<string, { task: Record<string, unknown>; inputSchema: unknown }>();
  for (const task of tasks) {
    const id = typeof task["id"] === "string" ? task["id"] : "";
    if (state.get(id) !== "SUCCEEDED") continue;
    const reported = reportedResources(outputs.get(id) ?? null);
    if (reported.length === 0) continue;
    const product = await productOfTask(products, task);
    // Only a team's registered product's: its team owns the type and id, and
    // its cleanup is what deletes them. A step runs its own team's products
    // (or the platform's, which have no team), so that's the step's team.
    const team = typeof task["team"] === "string" ? task["team"] : null;
    if (!product?.teamId || !team) continue;
    reporters.set(id, { task, inputSchema: product.inputSchema });
    const provides = providedBy(product.outputSchema, outputs.get(id) ?? {});
    for (const r of reported) {
      rows.push({
        product: product.name,
        productTeam: team,
        type: r.type,
        externalId: r.id,
        name: r.name,
        link: r.link,
        // A template's (or action's) run is for its team, or its person
        // alone; a DAG is its steps' teams'.
        ownerTeam: run.template !== null ? run.onBehalfOf : team,
        ownerUserId: run.submittedBy,
        executionId: run.executionId,
        taskId: id,
        inputs: resolvedInputs(task["inputs"], outputs),
        outputs: outputs.get(id) ?? {},
        position: order.get(id) ?? 0,
        provides,
      });
    }
  }
  await db.transaction(async (tx) => {
    // The resources each step reported that this run now has: those it
    // made, or updated as their owner (not one another owner keeps).
    const recorded = new Map<string, string[]>();
    for (const row of rows) {
      const [kept] = await tx
        .insert(resources)
        .values(row)
        .onConflictDoUpdate({
          target: [resources.productTeam, resources.type, resources.externalId],
          // A later step reporting it again: its owner's (the same team, or
          // the same person when it's nobody's team's) updates it; anyone
          // else's report leaves it the first owner's, so only who made it
          // (and admins) may delete it. One deleted and made again is the
          // new maker's.
          setWhere: sql`${resources.deletedAt} IS NOT NULL
            OR (${resources.ownerTeam} IS NOT NULL AND ${resources.ownerTeam} = excluded.owner_team)
            OR (${resources.ownerTeam} IS NULL AND excluded.owner_team IS NULL AND ${resources.ownerUserId} = excluded.owner_user_id)`,
          set: {
            product: row.product,
            name: row.name,
            link: row.link,
            ownerTeam: sql`CASE WHEN ${resources.deletedAt} IS NOT NULL THEN excluded.owner_team ELSE ${resources.ownerTeam} END`,
            ownerUserId: sql`CASE WHEN ${resources.deletedAt} IS NOT NULL THEN excluded.owner_user_id ELSE ${resources.ownerUserId} END`,
            executionId: row.executionId,
            taskId: row.taskId,
            inputs: row.inputs,
            outputs: row.outputs,
            position: row.position,
            provides: row.provides,
            reportedAt: sql`now()`,
            deletedAt: null,
          },
        })
        .returning({ id: resources.id });
      if (kept) recorded.set(row.taskId, [...(recorded.get(row.taskId) ?? []), kept.id]);
    }
    // What each depends on, as of this run: replaced, so a resource reported
    // again depends on what its latest step took.
    for (const [taskId, ids] of recorded) {
      const reporter = reporters.get(taskId);
      if (!reporter) continue;
      const links = new Map<string, { dependsOnId: string; input: string; wiringType: string | null }>();
      const inputs = isRecord(reporter.task["inputs"]) ? reporter.task["inputs"] : {};
      for (const [input, raw] of Object.entries(inputs)) {
        const wiringType = hintOf(reporter.inputSchema, input, "x-vertra-needs");
        let found: { id: string }[] = [];
        if (isReference(raw)) {
          // Wired from another step of this run: what that step reported.
          found = await tx
            .select({ id: resources.id })
            .from(resources)
            .where(and(eq(resources.executionId, run.executionId), eq(resources.taskId, raw.$fromTask), isNull(resources.deletedAt)));
        } else if (wiringType && scalar(raw) !== null) {
          // A value of its type: whatever live resource provides it, from
          // any run (the project an earlier order made).
          const wanted = JSON.stringify([{ type: wiringType, value: scalar(raw) }]);
          found = await tx
            .select({ id: resources.id })
            .from(resources)
            .where(and(isNull(resources.deletedAt), sql`${resources.provides} @> ${wanted}::jsonb`));
        }
        for (const { id } of found) {
          // Never its own step's (a project.create given the id it makes).
          if (!ids.includes(id)) links.set(`${id}/${input}`, { dependsOnId: id, input, wiringType });
        }
      }
      await tx.delete(resourceLinks).where(inArray(resourceLinks.resourceId, ids));
      const values = ids.flatMap((resourceId) => [...links.values()].map((link) => ({ resourceId, ...link })));
      if (values.length > 0) await tx.insert(resourceLinks).values(values).onConflictDoNothing();
    }
    // This run's deletes: done where their step succeeded. One that didn't
    // stays this run's last attempt, free to be asked for again, or to
    // succeed if the run is retried (and so recorded again).
    const deleting = await tx.select({ id: resources.id, taskId: resources.deletingTaskId }).from(resources).where(eq(resources.deletingExecutionId, run.executionId));
    const deleted = deleting.filter((r) => state.get(r.taskId ?? "") === "SUCCEEDED").map((r) => r.id);
    if (deleted.length > 0) {
      await tx.update(resources).set({ deletedAt: sql`now()` }).where(and(inArray(resources.id, deleted), isNull(resources.deletedAt)));
      // A delete waiting for an admin, of what's all gone now (deleted with
      // what depended on it): nothing left to approve.
      await tx
        .update(resourceDeleteRequests)
        .set({ decision: "deleted", decidedAt: sql`now()` })
        .where(
          and(
            isNull(resourceDeleteRequests.decision),
            sql`NOT EXISTS (SELECT 1 FROM ${resources} WHERE ${resources.id} = ANY(${resourceDeleteRequests.resourceIds}) AND ${resources.deletedAt} IS NULL)`,
          ),
        );
    }
    await tx.update(submittedExecutions).set({ resourcesRecordedAt: sql`now()` }).where(eq(submittedExecutions.executionId, run.executionId));
  });
  return rows.length;
}

/**
 * Where the last pass stopped in the runs not yet recorded (created_at as
 * Postgres writes it, to the microsecond, and execution id), so the next
 * goes on from there: runs that haven't finished, however many and however
 * old, are passed over instead of filling every pass ahead of newer ones.
 * Back to the oldest once a pass reaches the end. Each replica keeps its
 * own; a run two replicas both record is recorded the same twice and told
 * once (its news has keys).
 */
let cursor: { time: string; id: string } | null = null;

/** One pass: finished runs not yet recorded, oldest first from where the last pass stopped. */
export async function recordFinishedRuns({ perPass = PER_PASS }: { perPass?: number } = {}): Promise<{ runs: number; resources: number }> {
  const after = cursor;
  const pending = await db
    .select({
      executionId: submittedExecutions.executionId,
      name: submittedExecutions.name,
      teams: submittedExecutions.teams,
      submittedBy: submittedExecutions.submittedBy,
      payload: submittedExecutions.payload,
      template: submittedExecutions.template,
      onBehalfOf: submittedExecutions.onBehalfOf,
      cursorTime: sql<string>`${submittedExecutions.createdAt}::text`,
    })
    .from(submittedExecutions)
    .where(
      and(
        isNull(submittedExecutions.resourcesRecordedAt),
        after ? sql`(${submittedExecutions.createdAt}, ${submittedExecutions.executionId}) > (${after.time}::timestamptz, ${after.id}::uuid)` : undefined,
      ),
    )
    .orderBy(asc(submittedExecutions.createdAt), asc(submittedExecutions.executionId))
    .limit(perPass);
  if (pending.length === 0) {
    cursor = null;
    return { runs: 0, resources: 0 };
  }
  const states = new Map((await getExecutionStates(pending.map((r) => r.executionId))).map((s) => [s.executionId, s]));
  let runs = 0;
  let recorded = 0;
  let stopped = false;
  for (const run of pending) {
    // Done with: the next pass goes on after it. One that throws isn't, so
    // the next pass starts with it.
    const passed = () => {
      cursor = { time: run.cursorTime, id: run.executionId };
    };
    const { state, updatedAt } = states.get(run.executionId) ?? {};
    if (state === undefined) {
      // The kernel no longer has it (past its retention): nothing to read.
      await db
        .update(submittedExecutions)
        .set({ resourcesRecordedAt: sql`now()` })
        .where(and(eq(submittedExecutions.executionId, run.executionId), isNull(submittedExecutions.resourcesRecordedAt)));
      passed();
      continue;
    }
    if (!FINISHED.has(state)) {
      // Not finished yet: looked at again when the cursor comes round.
      passed();
      continue;
    }
    if (runs === READ_PER_PASS) {
      // Enough read for one pass: this one and what's after it, next pass.
      stopped = true;
      break;
    }
    if (run.template === "check") {
      // A readiness check: its answer is the product's (readiness.ts).
      await recordCheck(run.executionId, await getExecution(run.executionId));
      await db.update(submittedExecutions).set({ resourcesRecordedAt: sql`now()` }).where(eq(submittedExecutions.executionId, run.executionId));
      runs += 1;
      passed();
      continue;
    }
    if (run.template === "preview") {
      // A preview changes nothing and says so itself: no resources, no news.
      await db.update(submittedExecutions).set({ resourcesRecordedAt: sql`now()` }).where(eq(submittedExecutions.executionId, run.executionId));
      runs += 1;
      passed();
      continue;
    }
    const detail = await getExecution(run.executionId);
    // Told first: if recording fails, the next pass tells again, which its key makes a no-op.
    const failed = detail.tasks.find((t) => t.state === "FAILED");
    await runFinished({
      executionId: run.executionId,
      name: run.name,
      state,
      submittedBy: run.submittedBy,
      teams: run.template !== null ? (run.onBehalfOf ? [run.onBehalfOf] : []) : run.teams,
      finishedAt: updatedAt ?? null,
      failedStep: failed ? { taskId: failed.taskId, code: typeof failed.failure?.["code"] === "string" ? failed.failure["code"] : "an error" } : undefined,
    });
    await runFinishedCallbacks({ ...run, state, finishedAt: updatedAt ?? null, tasks: detail.tasks });
    recorded += await recordRun(run, detail);
    runs += 1;
    passed();
  }
  // Reached the end of what's not recorded: from the oldest again next pass.
  if (!stopped && pending.length < perPass) cursor = null;
  return { runs, resources: recorded };
}

export function startResourceRecorder(log: FastifyBaseLogger): void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    recordFinishedRuns()
      .then((done) => {
        if (done.resources > 0) log.info({ event: "resources_recorded", ...done }, "recorded what finished runs made");
      })
      .catch((error: unknown) => {
        log.error({ err: error }, "couldn't record what finished runs made");
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  setInterval(run, 30_000).unref();
}
