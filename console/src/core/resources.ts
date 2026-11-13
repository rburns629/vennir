// SPDX-License-Identifier: MIT
/**
 * What runs made, and deleting it (ResourceService; decision 21,
 * docs/assessment.md). resourceRecorder.ts copies each resource a step
 * reported, with that step's inputs and outputs, when its run finishes.
 *
 * Who sees one: the team the run was for (or, for a run for nobody's team,
 * whoever ran it), the team whose product reported it, and admins. Who
 * deletes one: the team it was for, whoever ran it, and admins. Deleting
 * runs its product's current cleanup action (product.yaml's cleanup) as a
 * run of its own, for that team, with the same checks as running the
 * action: it must be shared with them, and approvals apply. Several are
 * deleted in one run, newest first, one after another. A resource is
 * deleted once its step succeeds (resourceRecorder.ts).
 *
 * What depends on what (decision 25, resourceLinks): a resource others
 * still depend on isn't deleted on its own say. Deleting it is refused
 * (HAS_DEPENDENTS), recorded as a request, and the admins are alerted; it
 * runs once an admin approves the request. Deleting the dependents with it
 * needs no approval: they're deleted first.
 */
import type { FastifyBaseLogger } from "fastify";
import { Code } from "@connectrpc/connect";
import { and, desc, eq, ilike, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ApiError } from "../apiError.js";
import type { AuthUser } from "../auth/plugin.js";
import { db } from "../db/client.js";
import { findRunnableProduct } from "../db/queries.js";
import { resourceDeleteRequests, resourceLinks, resources, submittedExecutions, users, type Provided } from "../db/schema.js";
import { platformAlert } from "../notifier.js";
import { getExecutionStates } from "../kernel/client.js";
import { runCleanup, siblingAction, type ProductStep, type TeamProduct } from "./templates.js";

export type ResourceState = "exists" | "deleting" | "delete_failed" | "deleted";

export interface ResourceView {
  id: string;
  type: string;
  externalId: string;
  name: string | null;
  link: string | null;
  /** The registered product whose step reported it, and its team. */
  product: string;
  productTeam: string;
  /** The team it was made for (null: for whoever ran it alone), and who ran it. */
  ownerTeam: string | null;
  ownerEmail: string | null;
  /** The run and step that last reported it. */
  executionId: string;
  taskId: string;
  firstReportedAt: Date;
  reportedAt: Date;
  state: ResourceState;
  /** The last delete asked for: its run. */
  deletingExecutionId: string | null;
  deletedAt: Date | null;
  /** Whether the caller may delete it now: theirs to delete, there, and its product says how. */
  canDelete: boolean;
  /** What its step provided, by wiring type. */
  provides: Provided[];
  /** What it depends on, and what still depends on it, of what the caller may see. */
  dependsOn: ResourceRef[];
  dependents: ResourceRef[];
  /** Live dependents the caller may not see. */
  hiddenDependents: number;
}

export interface ResourceRef {
  id: string;
  type: string;
  externalId: string;
  name: string | null;
  executionId: string;
  /** The input of the dependent's step it came in through. */
  input: string;
}

export interface ResourceFilter {
  executionId?: string | undefined;
  team?: string | undefined;
  /** Matched against type, id and name. */
  query?: string | undefined;
  includeDeleted?: boolean | undefined;
  /** Only these. */
  ids?: string[] | undefined;
}

const LIST_LIMIT = 200;
const DELETE_LIMIT = 50;

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

/** Rows the caller may see. */
function visibleTo(who: AuthUser): SQL | undefined {
  if (who.isAdmin) return undefined;
  const teams = who.teamNames.length > 0 ? who.teamNames : [""];
  return or(inArray(resources.ownerTeam, teams), inArray(resources.productTeam, teams), eq(resources.ownerUserId, who.id));
}

function mayDelete(who: AuthUser, row: { ownerTeam: string | null; ownerUserId: string | null }): boolean {
  return who.isAdmin || row.ownerUserId === who.id || (row.ownerTeam !== null && who.teamNames.includes(row.ownerTeam));
}

async function select(where: (SQL | undefined)[], limit: number) {
  return db
    .select({
      resource: resources,
      ownerEmail: users.email,
      // The last delete's run has been looked at since it finished: not in progress.
      deleteFinished: isNotNull(submittedExecutions.resourcesRecordedAt).mapWith(Boolean),
      deleteRunKnown: isNotNull(submittedExecutions.executionId).mapWith(Boolean),
    })
    .from(resources)
    .leftJoin(users, eq(users.id, resources.ownerUserId))
    .leftJoin(submittedExecutions, eq(submittedExecutions.executionId, resources.deletingExecutionId))
    .where(and(...where))
    .orderBy(desc(resources.firstReportedAt), desc(resources.position))
    .limit(limit);
}

type Row = Awaited<ReturnType<typeof select>>[number];

function stateOf(row: Row): ResourceState {
  const r = row.resource;
  if (r.deletedAt) return "deleted";
  if (!r.deletingExecutionId) return "exists";
  // Its run gone (past retention) or finished without deleting it.
  if (!row.deleteRunKnown || row.deleteFinished) return "delete_failed";
  return "deleting";
}

/** The links into and out of `ids`, with the resource at the other end, live ones only. */
async function linksOf(ids: string[]) {
  if (ids.length === 0) return { out: [], into: [] };
  const other = (column: typeof resourceLinks.resourceId | typeof resourceLinks.dependsOnId) =>
    db
      .select({
        from: resourceLinks.resourceId,
        to: resourceLinks.dependsOnId,
        input: resourceLinks.input,
        other: resources,
      })
      .from(resourceLinks)
      .innerJoin(resources, and(eq(resources.id, column), isNull(resources.deletedAt)));
  const [out, into] = await Promise.all([
    other(resourceLinks.dependsOnId).where(inArray(resourceLinks.resourceId, ids)),
    other(resourceLinks.resourceId).where(inArray(resourceLinks.dependsOnId, ids)),
  ]);
  return { out, into };
}

function seenBy(who: AuthUser, r: { ownerTeam: string | null; productTeam: string; ownerUserId: string | null }): boolean {
  return who.isAdmin || r.ownerUserId === who.id || (r.ownerTeam !== null && who.teamNames.includes(r.ownerTeam)) || who.teamNames.includes(r.productTeam);
}

function refOf(r: typeof resources.$inferSelect, input: string): ResourceRef {
  return { id: r.id, type: r.type, externalId: r.externalId, name: r.name, executionId: r.executionId, input };
}

async function view(who: AuthUser, rows: Row[]): Promise<ResourceView[]> {
  const cleanable = new Map<string, boolean>();
  for (const name of new Set(rows.map((row) => row.resource.product))) {
    cleanable.set(name, (await findRunnableProduct(name))?.cleanup != null);
  }
  const { out, into } = await linksOf(rows.map((row) => row.resource.id));
  return rows.map((row) => {
    const r = row.resource;
    const state = stateOf(row);
    return {
      id: r.id,
      type: r.type,
      externalId: r.externalId,
      name: r.name,
      link: r.link,
      product: r.product,
      productTeam: r.productTeam,
      ownerTeam: r.ownerTeam,
      ownerEmail: row.ownerEmail,
      executionId: r.executionId,
      taskId: r.taskId,
      firstReportedAt: r.firstReportedAt,
      reportedAt: r.reportedAt,
      state,
      deletingExecutionId: r.deletingExecutionId,
      deletedAt: r.deletedAt,
      canDelete: (state === "exists" || state === "delete_failed") && mayDelete(who, r) && (cleanable.get(r.product) ?? false),
      provides: r.provides,
      dependsOn: out.filter((l) => l.from === r.id && seenBy(who, l.other)).map((l) => refOf(l.other, l.input)),
      dependents: into.filter((l) => l.to === r.id && seenBy(who, l.other)).map((l) => refOf(l.other, l.input)),
      hiddenDependents: new Set(into.filter((l) => l.to === r.id && !seenBy(who, l.other)).map((l) => l.other.id)).size,
    };
  });
}

/** What the caller may see of what runs made, newest first: a run's, a team's, or matching a search. */
export async function listResources(caller: AuthUser | undefined, filter: ResourceFilter): Promise<ResourceView[]> {
  const who = signedIn(caller);
  const query = filter.query?.trim();
  const rows = await select(
    [
      visibleTo(who),
      filter.executionId ? eq(resources.executionId, filter.executionId) : undefined,
      filter.team ? or(eq(resources.ownerTeam, filter.team), eq(resources.productTeam, filter.team)) : undefined,
      query
        ? or(
            ilike(resources.type, `%${escapeLike(query)}%`),
            ilike(resources.externalId, `%${escapeLike(query)}%`),
            ilike(resources.name, `%${escapeLike(query)}%`),
          )
        : undefined,
      filter.includeDeleted ? undefined : isNull(resources.deletedAt),
      filter.ids && filter.ids.length > 0 ? inArray(resources.id, filter.ids) : undefined,
    ],
    LIST_LIMIT,
  );
  return view(who, rows);
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A cleanup action's inputs for one resource: {"resource": ...} unless
 * product.yaml maps them, from the reporting step's recorded inputs and
 * outputs and the resource itself.
 */
export function cleanupInputs(
  mapping: Record<string, unknown> | null,
  recorded: { inputs: Record<string, unknown>; outputs: Record<string, unknown>; type: string; externalId: string; name: string | null; link: string | null },
): Record<string, unknown> {
  const resource = {
    type: recorded.type,
    id: recorded.externalId,
    ...(recorded.name ? { name: recorded.name } : {}),
    ...(recorded.link ? { link: recorded.link } : {}),
  };
  if (!mapping) return { resource };
  const fields: Record<string, unknown> = resource;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mapping)) {
    const ref = typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : [];
    const [kind, field] = ref.length === 1 ? (ref[0] ?? []) : [];
    const picked =
      kind === "$input" ? recorded.inputs[String(field)] : kind === "$output" ? recorded.outputs[String(field)] : kind === "$resource" ? fields[String(field)] : value;
    // A field the step didn't have is left out, as a template's missing parameter is.
    if (picked !== undefined) out[name] = picked;
  }
  return out;
}

/** The cleanup action of the product that reported a resource, as registered now. */
async function cleanupOf(productName: string, label: string): Promise<{ product: TeamProduct; mapping: Record<string, unknown> | null }> {
  const reporter = await findRunnableProduct(productName);
  if (!reporter) {
    throw new ApiError(409, "CLEANUP_UNAVAILABLE", `${label}: ${productName}, which made it, isn't registered here any more (or its team is retired).`);
  }
  if (!reporter.cleanup) {
    throw new ApiError(409, "NO_CLEANUP", `${label}: ${productName} doesn't say how to delete what it makes (its product.yaml has no cleanup).`);
  }
  const product = await siblingAction(reporter, reporter.cleanup.action);
  if (!product) {
    throw new ApiError(409, "CLEANUP_UNAVAILABLE", `${label}: ${productName}'s cleanup action, ${reporter.cleanup.action}, isn't registered here.`);
  }
  return { product, mapping: reporter.cleanup.inputs };
}

const FINISHED = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/**
 * Deletes resources: one run of their products' cleanup actions, newest
 * first, for the team they were made for. All must be the caller's to
 * delete, there now, and made for the same team.
 */
export async function deleteResources(caller: AuthUser | undefined, ids: string[], log: FastifyBaseLogger): Promise<{ executionId: string }> {
  return deleteChecked(signedIn(caller), ids, log, null);
}

/** deleteResources, or (approved: the request's id) an admin's approval of a delete others depended on. */
async function deleteChecked(who: AuthUser, ids: string[], log: FastifyBaseLogger, approved: string | null): Promise<{ executionId: string }> {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > DELETE_LIMIT) {
    throw new ApiError(400, "BAD_REQUEST", `Name 1 to ${String(DELETE_LIMIT)} resources to delete.`);
  }
  const rows = await select([inArray(resources.id, unique), visibleTo(who)], DELETE_LIMIT);
  if (rows.length !== unique.length) throw new ApiError(404, "NOT_FOUND", "A resource to delete wasn't found.");
  const owners = new Set(rows.map((row) => row.resource.ownerTeam));
  if (owners.size > 1) throw new ApiError(422, "MIXED_OWNERS", "These were made for different teams: delete each team's separately.");
  // A delete whose run has finished, but which the recorder (every 30s)
  // hasn't looked at yet, isn't in progress: asked of the kernel, so a
  // failed one can be tried again at once.
  const pending = rows.filter((row) => stateOf(row) === "deleting").map((row) => row.resource.deletingExecutionId ?? "");
  const finishedRuns = new Set(
    pending.length === 0 ? [] : (await getExecutionStates([...new Set(pending)])).filter((e) => FINISHED.has(e.state)).map((e) => e.executionId),
  );
  const steps: (Omit<ProductStep, "id"> & { madeFor: string })[] = [];
  for (const row of rows) {
    const r = row.resource;
    const label = `${r.type} ${r.externalId}`;
    if (!mayDelete(who, r)) {
      throw new ApiError(403, "FORBIDDEN", `${label} isn't yours to delete: ask team "${r.ownerTeam ?? r.productTeam}".`);
    }
    const state = stateOf(row);
    if (state === "deleted") throw new ApiError(409, "ALREADY_DELETED", `${label} is already deleted.`);
    if (state === "deleting" && !finishedRuns.has(r.deletingExecutionId ?? "")) {
      throw new ApiError(409, "DELETE_IN_PROGRESS", `${label} is being deleted already.`);
    }
  }
  // What still depends on them, besides each other: refused, unless an
  // admin approved it.
  const asked = rows.map((row) => row.resource.id);
  const dependents = await db
    .selectDistinct({
      id: resources.id,
      type: resources.type,
      externalId: resources.externalId,
      ownerTeam: resources.ownerTeam,
      productTeam: resources.productTeam,
      ownerUserId: resources.ownerUserId,
    })
    .from(resourceLinks)
    .innerJoin(resources, and(eq(resources.id, resourceLinks.resourceId), isNull(resources.deletedAt)))
    .where(and(inArray(resourceLinks.dependsOnId, asked), notInArray(resourceLinks.resourceId, asked)));
  if (dependents.length > 0 && approved === null) {
    const request = await requestApproval(who, rows.map((row) => row.resource), dependents.map((d) => d.id), log);
    // Named only where the caller may see them, as a resource's own page
    // does (view's hiddenDependents): another team's are counted.
    const seen = dependents.filter((d) => seenBy(who, d));
    const hidden = dependents.length - seen.length;
    const named = [
      ...seen.slice(0, 3).map((d) => `${d.type} ${d.externalId}`),
      ...(seen.length > 3 ? ["..."] : []),
      ...(hidden > 0 ? [`${String(hidden)} of other teams'`] : []),
    ];
    throw new ApiError(
      409,
      "HAS_DEPENDENTS",
      `${String(dependents.length)} other resource(s) still depend on this (${named.join(", ")}). Delete them with it, or wait for an admin to approve deleting it anyway: they've been asked.`,
      Code.FailedPrecondition,
      { requestId: request, dependents: seen.map((d) => d.id), hiddenDependents: hidden },
    );
  }
  // Newest first, but whatever depends on another of them before it.
  const { into } = await linksOf(asked);
  const ordered = dependentsFirst(
    rows,
    into.filter((l) => asked.includes(l.from)),
  );
  for (const row of ordered) {
    const r = row.resource;
    const label = `${r.type} ${r.externalId}`;
    const { product, mapping } = await cleanupOf(r.product, label);
    // For the team it was made for (one made for a person alone: its
    // product's team, as its run's step was), whoever asks.
    steps.push({ product, inputs: cleanupInputs(mapping, r), label, madeFor: r.ownerTeam ?? r.productTeam });
  }
  const ownerTeam = rows[0]?.resource.ownerTeam ?? undefined;
  // For the team it was made for, when the caller is in it (else an admin or the person alone).
  const forTeam = ownerTeam && who.teamNames.includes(ownerTeam) ? ownerTeam : undefined;
  const name = rows.length === 1 ? `Delete ${rows[0]?.resource.type ?? ""} ${rows[0]?.resource.externalId ?? ""}` : `Delete ${String(rows.length)} resources`;
  const { executionId, stepIds } = await runCleanup(who, name.slice(0, 200), steps, forTeam, ordered.map((row) => row.resource.id), log);
  await db.transaction(async (tx) => {
    for (const [i, row] of ordered.entries()) {
      await tx
        .update(resources)
        .set({ deletingExecutionId: executionId, deletingTaskId: stepIds[i] ?? null, deleteRequestedBy: who.id })
        .where(eq(resources.id, row.resource.id));
    }
  });
  log.info({ event: "resources_delete_requested", executionId, resources: ordered.map((row) => row.resource.id), approved }, "asked to delete resources");
  return { executionId };
}

/** `rows` (newest first) with each one that depends on another of them moved before it. */
export function dependentsFirst<T extends { resource: { id: string } }>(rows: T[], links: { from: string; to: string }[]): T[] {
  const out: T[] = [];
  const left = [...rows];
  while (left.length > 0) {
    // The first whose dependents among those left are all placed already.
    const next = left.findIndex((row) => !links.some((l) => l.to === row.resource.id && left.some((o) => o !== row && o.resource.id === l.from)));
    out.push(...left.splice(next === -1 ? 0 : next, 1));
  }
  return out;
}

/** Records a delete others depend on, once per asker and set, and alerts the admins. Its id. */
async function requestApproval(
  who: AuthUser,
  asked: (typeof resources.$inferSelect)[],
  dependentIds: string[],
  log: FastifyBaseLogger,
): Promise<string> {
  const ids = asked.map((r) => r.id).sort();
  // One parameter, as Postgres writes an array (ids are UUIDs from the database).
  const same = `{${ids.join(",")}}`;
  const [waiting] = await db
    .select({ id: resourceDeleteRequests.id, resourceIds: resourceDeleteRequests.resourceIds })
    .from(resourceDeleteRequests)
    .where(and(isNull(resourceDeleteRequests.decision), eq(resourceDeleteRequests.requestedBy, who.id), sql`${resourceDeleteRequests.resourceIds} @> ${same}::uuid[] AND ${resourceDeleteRequests.resourceIds} <@ ${same}::uuid[]`));
  if (waiting) return waiting.id;
  const [made] = await db
    .insert(resourceDeleteRequests)
    .values({ resourceIds: ids, ownerTeam: asked[0]?.ownerTeam ?? null, requestedBy: who.id, dependentIds })
    .returning({ id: resourceDeleteRequests.id });
  const id = made?.id ?? "";
  const what = asked.length === 1 ? `${asked[0]?.type ?? ""} ${asked[0]?.externalId ?? ""}` : `${String(asked.length)} resources`;
  await platformAlert(
    `resource-delete:${id}`,
    `Approve deleting ${what}?`,
    `${String(dependentIds.length)} other resource(s) still depend on it. It's deleted only if an admin approves it (What runs made, Waiting for an admin).`,
    who.id,
    "/runs/made",
    log,
  );
  log.info({ event: "resource_delete_needs_approval", request: id, resources: ids, dependents: dependentIds }, "a delete others depend on waits for an admin");
  return id;
}

export interface DeleteRequestView {
  id: string;
  resources: ResourceRef[];
  dependents: ResourceRef[];
  ownerTeam: string | null;
  requestedBy: string | null;
  createdAt: Date;
  decision: "approved" | "denied" | "deleted" | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  executionId: string | null;
}

/** Deletes waiting for an admin, and recent decisions: every one for admins, else the caller's own. */
export async function listDeleteRequests(caller: AuthUser | undefined): Promise<DeleteRequestView[]> {
  const who = signedIn(caller);
  const requester = alias(users, "requester");
  const decider = alias(users, "decider");
  const rows = await db
    .select({ request: resourceDeleteRequests, requestedBy: requester.email, decidedBy: decider.email })
    .from(resourceDeleteRequests)
    .leftJoin(requester, eq(requester.id, resourceDeleteRequests.requestedBy))
    .leftJoin(decider, eq(decider.id, resourceDeleteRequests.decidedBy))
    .where(who.isAdmin ? undefined : eq(resourceDeleteRequests.requestedBy, who.id))
    .orderBy(sql`${resourceDeleteRequests.decision} IS NOT NULL`, desc(resourceDeleteRequests.createdAt))
    .limit(100);
  const ids = [...new Set(rows.flatMap((r) => [...r.request.resourceIds, ...r.request.dependentIds]))];
  const found = ids.length === 0 ? [] : await db.select().from(resources).where(inArray(resources.id, ids));
  const byId = new Map(found.map((r) => [r.id, r]));
  const refs = (list: string[]) => list.flatMap((id) => {
    const r = byId.get(id);
    return r && seenBy(who, r) ? [refOf(r, "")] : [];
  });
  return rows.map(({ request, requestedBy, decidedBy }) => ({
    id: request.id,
    resources: refs(request.resourceIds),
    dependents: refs(request.dependentIds),
    ownerTeam: request.ownerTeam,
    requestedBy,
    createdAt: request.createdAt,
    decision: request.decision,
    decidedBy,
    decidedAt: request.decidedAt,
    executionId: request.executionId,
  }));
}

/** An admin approves a waiting delete (it runs now, as theirs) or denies it. */
export async function decideDeleteRequest(caller: AuthUser | undefined, id: string, approve: boolean, log: FastifyBaseLogger): Promise<{ executionId: string | null }> {
  const who = signedIn(caller);
  if (!who.isAdmin) throw new ApiError(403, "FORBIDDEN", "Only an admin approves deleting what others depend on.");
  const [request] = await db.select().from(resourceDeleteRequests).where(eq(resourceDeleteRequests.id, id));
  if (!request) throw new ApiError(404, "NOT_FOUND", "No such delete request.");
  if (request.decision) throw new ApiError(409, "ALREADY_DECIDED", `It was ${request.decision} already.`);
  // Claimed first, so two admins can't both run it.
  const [claimed] = await db
    .update(resourceDeleteRequests)
    .set({ decision: approve ? "approved" : "denied", decidedBy: who.id, decidedAt: sql`now()` })
    .where(and(eq(resourceDeleteRequests.id, id), isNull(resourceDeleteRequests.decision)))
    .returning({ id: resourceDeleteRequests.id });
  if (!claimed) throw new ApiError(409, "ALREADY_DECIDED", "Another admin decided it already.");
  if (!approve) return { executionId: null };
  try {
    const { executionId } = await deleteChecked(who, request.resourceIds, log, id);
    await db.update(resourceDeleteRequests).set({ executionId }).where(eq(resourceDeleteRequests.id, id));
    return { executionId };
  } catch (error) {
    // Not run (deleted since, say): waiting again, for the admin to see why.
    await db.update(resourceDeleteRequests).set({ decision: null, decidedBy: null, decidedAt: null }).where(eq(resourceDeleteRequests.id, id));
    throw error;
  }
}

/** Deletes what a run made that's still there and the caller may delete (its product says how), in the reverse of the order it was made. */
export async function deleteRunResources(caller: AuthUser | undefined, executionId: string, log: FastifyBaseLogger): Promise<{ executionId: string }> {
  const who = signedIn(caller);
  const rows = await select([eq(resources.executionId, executionId), visibleTo(who), isNull(resources.deletedAt)], DELETE_LIMIT);
  const deletable = (await view(who, rows)).filter((r) => r.canDelete);
  if (deletable.length === 0) throw new ApiError(404, "NOT_FOUND", "Nothing this run made is left for you to delete.");
  return deleteResources(caller, deletable.map((r) => r.id), log);
}

