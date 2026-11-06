// SPDX-License-Identifier: MIT
/**
 * Executions: the authorized front door to kernel-api (KernelService,
 * through kernel/client.ts), which accepts only this console's
 * ServiceAccount token and knows nothing of users or teams. The logic
 * behind ExecutionService.
 *
 * Every operation checks the caller's real team membership (or admin)
 * before anything reaches kernel-api, using submittedExecutions
 * (db/schema.ts) as the record of which teams may see which execution,
 * since kernel-api can't answer that. A refusal is an ApiError; kernel-api's
 * own refusals propagate as KernelApiError, for each transport to relay.
 */
import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "../apiError.js";
import { ensureMayOrder, ensureTeamMaintainer, loadExecution } from "../auth/access.js";
import { failureHelp, type FailureHelp } from "../failureHelp.js";
import type { AuthUser } from "../auth/plugin.js";
import { config } from "../config.js";
import {
  findTeamById,
  findTeamByName,
  findTeamByNameIncludingDeleted,
  findUserById,
  InvalidCursorError,
  isSecretRegistered,
  listProductsUsableBy,
  listSubmittedExecutionsPage,
  recordSubmittedExecution,
  type Product,
  type SubmittedExecution,
  markResourcesUnrecorded,
  scheduleThatStarted,
} from "../db/queries.js";
import {
  allowedPrefixes,
  imageRefusal,
  imageRepository,
  readImagePolicy,
  readImagePolicyForDisplay,
  type ImagePolicy,
} from "../imagePolicy.js";
import { ensureServiceAccount, NamespaceNotFoundError } from "../k8s.js";
import {
  cancelExecution,
  getExecution,
  getExecutionEvents,
  getExecutionLogs,
  getExecutionStates,
  retryTask,
  submitExecution,
  type ExecutionStateEntry,
} from "../kernel/client.js";
import { admitReleases, markReleasesUsed, releasedImageKey, releasedImages, UNREGISTERED_SERVICE_ACCOUNT } from "../productPolicy.js";
import { unlistedByKernel } from "../catalogPolicy.js";
import { ensureStillRunnable, rerunTemplate } from "./templates.js";
import { mayDecide, notDeciders, notDecidersOf, taskTeams } from "./approvals.js";
import { visibleLines } from "../logLevels.js";
import { failureCodeOnly, runView, visibleEvent, visiblePayload } from "./runView.js";
import { errorMessage, errorPath, schemaErrors } from "../jsonSchema.js";
import { missingImages, pinImages } from "../registry.js";
import { platformAlert } from "../notifier.js";
import { digestOf, scanBlocker } from "../scanning.js";
import { narrowWiredTargets, targetProblems, targetsNeedApproval } from "../targets.js";
import { CHECK_RUN } from "../readiness.js";
import { ensureRunsHere } from "./clouds.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Structural validation only: just enough to extract every task's `team`
 * for the authorization checks. kernel-api is the authority on the rest
 * (its DAG checks); kernel/client.ts turns the JSON into its request under
 * exactly the names checked here, refusing any other.
 */
interface TaskAuthInfo {
  team: string;
  // Undefined when absent or not a string: kernel-api refuses that task
  // anyway, but it then can't pass the checks below either.
  id: string | undefined;
  image: string | undefined;
  action: string | undefined;
  serviceAccount: string | undefined;
  secretRefs: string[];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractTasksAuthInfo(body: unknown): TaskAuthInfo[] | null {
  if (!isRecord(body) || !Array.isArray(body["tasks"]) || body["tasks"].length === 0) {
    return null;
  }
  const result: TaskAuthInfo[] = [];
  for (const task of body["tasks"]) {
    if (!isRecord(task) || typeof task["team"] !== "string" || task["team"].length === 0) {
      return null;
    }
    let secretRefs: string[] = [];
    if ("secretRefs" in task) {
      const raw = task["secretRefs"];
      if (!Array.isArray(raw) || !raw.every((s): s is string => typeof s === "string" && s.length > 0)) {
        return null;
      }
      secretRefs = raw;
    }
    result.push({
      team: task["team"],
      id: optionalString(task["id"]),
      image: optionalString(task["image"]),
      action: optionalString(task["action"]),
      serviceAccount: optionalString(task["serviceAccount"]),
      secretRefs,
    });
  }
  return result;
}

export interface RunBlocker {
  error:
    | "TEAM_PURGED"
    | "TEAM_RETIRED"
    | "IMAGE_NOT_FOUND"
    | "IMAGE_NOT_ALLOWED"
    | "IMAGE_POLICY_NOT_CONFIGURED"
    | "IMAGE_NOT_RESOLVED";
  message: string;
  missingImages?: string[];
  disallowedImages?: string[];
  allowedSources?: string[];
}

/** A blocker as a refusal: its own code and message, the rest as extra fields. */
function blocked(statusCode: number, { error, message, ...rest }: { error: string; message: string }): ApiError {
  return new ApiError(statusCode, error, message, undefined, rest);
}

/** Every task's image, for tasks that name one (task ids optional). */
function taskImages(body: unknown, taskId?: string): string[] {
  if (!isRecord(body) || !Array.isArray(body["tasks"])) return [];
  return body["tasks"]
    .filter((task): task is Record<string, unknown> => isRecord(task))
    .filter((task) => taskId === undefined || task["id"] === taskId)
    .map((task) => task["image"])
    .filter((image): image is string => typeof image === "string" && image.length > 0);
}

/** Why these images can't run: one from outside the allowed sources
 * (imagePolicy.ts; the cluster enforces the same rule at dispatch), or one
 * the registry says is gone (registry.ts, which also explains why an
 * unanswered check allows). */
async function imageBlocker(images: string[], policy: ImagePolicy): Promise<RunBlocker | null> {
  const refusal = imageRefusal(images, policy);
  if (refusal) return refusal;
  const missing = await missingImages(images, allowedPrefixes(policy));
  if (missing.length === 0) return null;
  return {
    error: "IMAGE_NOT_FOUND",
    message: `${missing.length === 1 ? "Image" : "Images"} no longer available in the registry: ${missing.join(", ")}.`,
    missingImages: missing,
  };
}

/** For the detail page's up-front notice only; rerun and retry enforce the
 * real check themselves. If the policy can't be read the page still loads,
 * without the notice. */
async function detailImageBlocker(payload: unknown, log: FastifyBaseLogger): Promise<RunBlocker | null> {
  let policy: ImagePolicy;
  try {
    policy = await readImagePolicyForDisplay();
  } catch (error) {
    log.warn({ err: error }, "couldn't read the image policy for an execution's rerun notice");
    return null;
  }
  return imageBlocker(taskImages(payload), policy);
}

interface RunContext {
  action: "submit" | "rerun" | "retry";
  teams: string[];
  executionId?: string;
  caller: AuthUser | undefined;
  log: FastifyBaseLogger;
}

/**
 * The image check for anything about to run (submit, rerun, retry): refuses
 * with 422 and logs who tried to run what, and what was allowed, so a
 * refusal is as clear in the logs as it is in the UI. Reading the policy
 * failing is a real error and propagates (nothing runs on a guess).
 */
async function refuseBlockedImages(images: string[], context: RunContext): Promise<void> {
  const blocker = await imageBlocker(images, await readImagePolicy());
  if (!blocker) return;
  context.log.warn(
    {
      event: blocker.error === "IMAGE_NOT_FOUND" ? "image_not_found" : "image_not_allowed",
      code: blocker.error,
      action: context.action,
      executionId: context.executionId,
      user: context.caller?.id,
      teams: context.teams,
      images: blocker.disallowedImages ?? blocker.missingImages,
      allowedSources: blocker.allowedSources,
    },
    blocker.message,
  );
  // An image gone from the registry breaks its product for everyone: once
  // an hour per image.
  if (blocker.error === "IMAGE_NOT_FOUND") {
    const hour = new Date().toISOString().slice(0, 13);
    for (const image of blocker.missingImages ?? []) {
      await platformAlert(`image-missing:${image}:${hour}`, "A run's image is gone from the registry", `${image}. Runs of it are refused until it's published again.`);
    }
  }
  throw blocked(422, blocker);
}

/**
 * Why nothing can run for this team any more, or null when it can. A purged
 * team's namespace and product images are gone, so the kernel would accept
 * the work and then fail every task. A retired team is read-only. A name
 * with no console team at all isn't blocked here: admins may still submit
 * for it, and the kernel's dispatch policy decides whether its namespace
 * may run anything.
 */
async function teamRunBlocker(teamName: string): Promise<RunBlocker | null> {
  const team = await findTeamByNameIncludingDeleted(teamName);
  if (team?.deletedAt) {
    return {
      error: "TEAM_PURGED",
      message: `Team "${teamName}" was purged: its namespace and product images no longer exist, so nothing can run for it again.`,
    };
  }
  if (team?.retiredAt) {
    return {
      error: "TEAM_RETIRED",
      message: `Team "${teamName}" is retired, so nothing new can run for it. An admin can un-retire it.`,
    };
  }
  return null;
}

async function runBlocker(teamNames: string[]): Promise<RunBlocker | null> {
  for (const team of teamNames) {
    const blocker = await teamRunBlocker(team);
    if (blocker) return blocker;
  }
  return null;
}

/**
 * Refuses (409, as for a task's own team) running anything for a team that
 * can't run anything: a run for a retired or purged team (`forTeams`, its
 * onBehalfOf and each step's), wherever its steps run, other teams'
 * namespaces included; and anything a team's bot runs once every team it
 * belongs to is retired, since a bot acts only for its teams. A bot of no
 * team (an automation token's) isn't one of a team's. With `adminCleanup`
 * (an admin's cleanup run), a retired team it's for doesn't stop it: what
 * the team's runs made can be deleted without un-retiring it, which would
 * let its people run anything again. A purged team's still does, and the
 * steps' own teams are checked as ever (authorizeTeams; the cluster runs
 * nothing in a retired team's namespace).
 */
async function refuseRetiredFor(
  caller: AuthUser | undefined,
  forTeams: (string | null | undefined)[],
  { adminCleanup = false }: { adminCleanup?: boolean } = {},
): Promise<void> {
  const named = [...new Set(forTeams.filter((team): team is string => typeof team === "string" && team !== ""))];
  for (const team of named) {
    const blocker = await teamRunBlocker(team);
    if (blocker && !(adminCleanup && blocker.error === "TEAM_RETIRED")) throw blocked(409, blocker);
  }
  if (!caller?.isBot || caller.teamNames.length === 0) return;
  let first: RunBlocker | null = null;
  for (const team of caller.teamNames) {
    const why = await teamRunBlocker(team);
    if (!why) return;
    first ??= why;
  }
  if (first) throw blocked(409, first);
}

/** The team each stored task ran for (withForTeam's forTeam). */
function taskForTeams(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload["tasks"])) return [];
  return payload["tasks"].flatMap((task: unknown) => {
    const forTeam = isRecord(task) ? optionalString(task["forTeam"]) : undefined;
    return forTeam ? [forTeam] : [];
  });
}

/**
 * The submission with every task's image pinned to the digest its tag names
 * right now (registry.ts's pinImages): a DAG may say `:latest`, and what
 * runs, what's retried and what's scanned is exactly the image resolved
 * here. Refuses (422) when the registry can't say which image a tag is.
 */
async function pinned(submission: Record<string, unknown>, context: RunContext): Promise<Record<string, unknown>> {
  const tasks = submission["tasks"];
  if (config.imagePinning === "off" || !Array.isArray(tasks)) return submission;
  const policy = await readImagePolicy();
  const { pinned: byImage, unresolved } = await pinImages(taskImages(submission), allowedPrefixes(policy));
  if (unresolved.length > 0) {
    context.log.warn({ event: "image_not_resolved", images: unresolved, user: context.caller?.id }, "couldn't pin images");
    throw new ApiError(
      422,
      "IMAGE_NOT_RESOLVED",
      `Couldn't ask the registry which image ${unresolved.length === 1 ? "this is" : "these are"}: ` +
        `${unresolved.join(", ")}. Every step runs a pinned image (its digest), so a tag is resolved at ` +
        "submission; try again, or name the image by digest.",
      undefined,
      { unresolvedImages: unresolved },
    );
  }
  return {
    ...submission,
    tasks: tasks.map((task: unknown) => {
      if (!isRecord(task) || typeof task["image"] !== "string") return task;
      return { ...task, image: byImage.get(task["image"]) ?? task["image"] };
    }),
  };
}

/**
 * Every (pinned) image must have passed its security scan, or been accepted
 * (scanning.ts): 422 for a failed scan, 409 (try again) for one still running.
 */
async function refuseUnscanned(images: string[], context: RunContext): Promise<void> {
  const blocker = await scanBlocker(images);
  if (!blocker) return;
  context.log.warn(
    {
      event: "image_scan_blocked",
      code: blocker.error,
      action: context.action,
      executionId: context.executionId,
      user: context.caller?.id,
      teams: context.teams,
      images: blocker.images.map((i) => i.image),
    },
    blocker.message,
  );
  throw blocked(blocker.error === "IMAGE_SCAN_FAILED" ? 422 : 409, blocker);
}

/**
 * Records who may see a just-submitted execution. kernel-api created it first
 * (only then is its id known), so if recording fails a new execution would
 * run where no one could see or stop it: it's cancelled instead, and the
 * error goes back to the caller, who can submit again. A replay (its
 * requestId used before) is left alone: it was recorded the first time.
 */
async function recordOrCancel(
  record: Parameters<typeof recordSubmittedExecution>[0],
  created: boolean,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    await recordSubmittedExecution(record);
  } catch (error) {
    if (!created) throw error;
    log.error({ err: error, executionId: record.executionId }, "couldn't record an execution; cancelling it");
    await cancelExecution(record.executionId).catch((cancelError: unknown) => {
      log.error({ err: cancelError, executionId: record.executionId }, "couldn't cancel the unrecorded execution");
    });
    throw error;
  }
}

// UNREGISTERED_SERVICE_ACCOUNT: the namespace's own ServiceAccount, which no
// product declares and no cloud identity is bound to: any task may run as
// it, with no secrets. Shared with the cluster's copy of this rule
// (productPolicy.ts).

const runsAs = (product: Product) => product.serviceAccount ?? UNREGISTERED_SERVICE_ACCOUNT;

/**
 * Why this task may not run as the ServiceAccount it names, or mount secrets
 * at all; null when it may. `matching` are the registered products (usable
 * in its team) its image and action are a release of: its action, and its
 * image by repository and digest (productLookup). `unreleased` are those of
 * its image's repository and action whose releases its digest isn't one of,
 * for the message. Which secrets it may mount is checked after (each must be
 * its team's).
 *
 * A ServiceAccount can carry a cloud identity (a product's GCP service
 * account through Workload Identity, say), so which one a task runs as
 * follows from what it runs: a product's release runs as the ServiceAccount
 * its reviewed product.yaml declares, and only a product's release may
 * mount its team's secrets; anything else, another image of the same
 * repository included, runs as "default" with none. Running as "default"
 * with no secrets is always allowed, products too: it grants nothing.
 */
function identityRefusal(task: TaskAuthInfo, matching: Product[], unreleased: Product[] = []): string | null {
  const label = task.id === undefined ? "A task" : `Task "${task.id}"`;
  const serviceAccount = task.serviceAccount ?? UNREGISTERED_SERVICE_ACCOUNT;
  if (serviceAccount === UNREGISTERED_SERVICE_ACCOUNT && task.secretRefs.length === 0) return null;
  if (matching.length === 0) {
    if (unreleased.length > 0) {
      return (
        `${label} runs "${task.image ?? ""}", which isn't a release of product "${unreleased[0]?.name ?? ""}" ` +
        `in use: a product's identity is its released images' alone (by digest), so this one can only run as ` +
        `ServiceAccount "${UNREGISTERED_SERVICE_ACCOUNT}" and mount no secrets. Run the image the product is ` +
        "registered at, or release this one through the catalog."
      );
    }
    return (
      `${label} runs "${task.image ?? ""}" (action "${task.action ?? ""}"), which isn't a registered ` +
      `product of team "${task.team}", so it can only run as ServiceAccount ` +
      `"${UNREGISTERED_SERVICE_ACCOUNT}" and mount no secrets.`
    );
  }
  if (!matching.some((product) => runsAs(product) === serviceAccount)) {
    const declared = [...new Set(matching.map(runsAs))].map((name) => `"${name}"`).join(" or ");
    return (
      `${label} runs product "${matching[0]?.name ?? ""}", which runs as ServiceAccount ` +
      `${declared} (its product.yaml), not "${serviceAccount}". Leave serviceAccount out to use its own.`
    );
  }
  return null;
}

/**
 * Finds the registered products a task runs, among its team's products and
 * the platform's: `matching`, those its action and image are a release of
 * (its image's repository and digest one of the product's releases in use,
 * productPolicy.ts's releasedImages: what gives it the product's identity);
 * `sameRepository`, those of its action and image repository, whatever the
 * digest (for describing a step, never for what it may do). Caches each
 * team's lookups for the length of one request.
 */
export function productLookup() {
  const teamIds = new Map<string, string | null>();
  const usableByTeamId = new Map<string | null, Product[]>();
  const released = new Map<string, Set<string>>();

  async function teamId(team: string): Promise<string | null> {
    if (!teamIds.has(team)) teamIds.set(team, (await findTeamByName(team))?.id ?? null);
    return teamIds.get(team) ?? null;
  }

  async function usable(team: string): Promise<Product[]> {
    const id = await teamId(team);
    let found = usableByTeamId.get(id);
    if (found === undefined) {
      found = await listProductsUsableBy(id);
      usableByTeamId.set(id, found);
    }
    return found;
  }

  async function sameRepository(team: string, image: string | undefined, action: string | undefined): Promise<Product[]> {
    const products = await usable(team);
    if (image === undefined) return [];
    const repository = imageRepository(image);
    return products.filter((product) => product.action === action && imageRepository(product.image) === repository);
  }

  // By the release's own repository, as the cluster's policy matches: an
  // earlier release still in use may be from a repository the product has
  // since moved off.
  async function matching(team: string, image: string | undefined, action: string | undefined): Promise<Product[]> {
    const key = image === undefined ? null : releasedImageKey(image);
    if (key === null) return [];
    const candidates = (await usable(team)).filter((product) => product.action === action);
    if (candidates.length === 0) return [];
    const unknown = candidates.filter((product) => !released.has(product.id));
    if (unknown.length > 0) {
      const found = await releasedImages(unknown.map((product) => product.id));
      for (const product of unknown) released.set(product.id, found.get(product.id) ?? new Set());
    }
    return candidates.filter((product) => released.get(product.id)?.has(key));
  }

  // Whose contract a step is held to (approval, inputs, targets, where it
  // runs): the product its release and identity are; or, for an image that
  // runs without that identity (another image of the repository, or a
  // release run as "default"), still that product's, so running without
  // the identity is never a way around its rules. Never for what's done
  // with or for the product (its identity, resources, preview): those take
  // its release (matching).
  async function forContract(team: string, image: string | undefined, action: string | undefined, serviceAccount: string): Promise<Product | undefined> {
    const released = await matching(team, image, action);
    const own = released.find((p) => runsAs(p) === serviceAccount);
    if (own) return own;
    const candidates = released.length > 0 ? released : await sameRepository(team, image, action);
    return candidates.find((p) => runsAs(p) === serviceAccount) ?? candidates[0];
  }

  return { teamId, matching, sameRepository, forContract };
}

/** A task as submitted, by its id. */
function payloadTask(payload: unknown, taskId: string): Record<string, unknown> | undefined {
  const tasks = isRecord(payload) && Array.isArray(payload["tasks"]) ? payload["tasks"] : [];
  return tasks.find((t): t is Record<string, unknown> => isRecord(t) && t["id"] === taskId);
}

/**
 * The registered product a task as submitted ran: by its team, released
 * image, action and identity. With `contract`, the product whose rules it's
 * held to though it ran without that identity (productLookup's
 * forContract), for deciding what it may do. With `anyDigest`, by its image
 * repository alone, for describing a step whose release may since have been
 * pruned (its failure's help).
 */
export async function productOfTask(
  products: ReturnType<typeof productLookup>,
  task: Record<string, unknown> | undefined,
  { anyDigest = false, contract = false }: { anyDigest?: boolean; contract?: boolean } = {},
): Promise<Product | undefined> {
  const teamName = optionalString(task?.["team"]);
  if (!teamName) return undefined;
  const image = optionalString(task?.["image"]);
  const action = optionalString(task?.["action"]);
  const serviceAccount = optionalString(task?.["serviceAccount"]) ?? UNREGISTERED_SERVICE_ACCOUNT;
  if (contract) return products.forContract(teamName, image, action, serviceAccount);
  const matching = await (anyDigest ? products.sameRepository : products.matching)(teamName, image, action);
  return matching.find((p) => runsAs(p) === serviceAccount);
}

/**
 * The submission with each task that names no `serviceAccount` given the one
 * it runs as: its product's, when every registered product it could be
 * declares the same one, otherwise "default". So a DAG needn't know a
 * product's identity, and the stored payload says what actually ran. Run
 * before authorization, which then checks what was filled in.
 */
async function withProductIdentities(submission: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tasks = submission["tasks"];
  if (!Array.isArray(tasks)) return submission;
  const products = productLookup();
  const filled: unknown[] = [];
  for (const task of tasks) {
    const team = isRecord(task) ? optionalString(task["team"]) : undefined;
    if (!isRecord(task) || "serviceAccount" in task || team === undefined) {
      filled.push(task);
      continue;
    }
    const matching = await products.matching(team, optionalString(task["image"]), optionalString(task["action"]));
    const declared = [...new Set(matching.map(runsAs))];
    filled.push({ ...task, serviceAccount: declared.length === 1 ? declared[0] : UNREGISTERED_SERVICE_ACCOUNT });
  }
  return { ...submission, tasks: filled };
}

/**
 * Creates each task's ServiceAccount in its team's namespace if it isn't
 * there yet (a platform product's, in a team it hasn't run in), after
 * authorization: only a product's own reaches here. Never modifies one.
 * Refuses (422) a team with no namespace.
 */
async function ensureServiceAccounts(tasksInfo: TaskAuthInfo[]): Promise<void> {
  const needed = new Set(
    tasksInfo
      .filter((task) => task.serviceAccount !== undefined && task.serviceAccount !== UNREGISTERED_SERVICE_ACCOUNT)
      .map((task) => JSON.stringify([task.team, task.serviceAccount])),
  );
  for (const entry of needed) {
    const [team, serviceAccount] = JSON.parse(entry) as [string, string];
    try {
      await ensureServiceAccount(team, serviceAccount);
    } catch (error) {
      if (!(error instanceof NamespaceNotFoundError)) throw error;
      throw new ApiError(422, "UNPROCESSABLE_ENTITY", error.message);
    }
  }
}

/**
 * The submission with each task that sets no `resources` of its own given its
 * product's, so the size a product declares travels with its tasks to
 * kernel-api (which fills anything still unset from its own default). Run
 * after authorization: the product chosen is the one the task's
 * ServiceAccount runs as, if there's one with a size.
 */
async function withProductResources(submission: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tasks = submission["tasks"];
  if (!Array.isArray(tasks)) return submission;
  const products = productLookup();
  const sized: unknown[] = [];
  for (const task of tasks) {
    const team = isRecord(task) ? optionalString(task["team"]) : undefined;
    if (!isRecord(task) || "resources" in task || team === undefined) {
      sized.push(task);
      continue;
    }
    const matching = await products.matching(team, optionalString(task["image"]), optionalString(task["action"]));
    const serviceAccount = optionalString(task["serviceAccount"]) ?? UNREGISTERED_SERVICE_ACCOUNT;
    const sizedProducts = matching.filter((product) => product.resources);
    const product = sizedProducts.find((p) => runsAs(p) === serviceAccount) ?? sizedProducts[0];
    sized.push(product?.resources ? { ...task, resources: product.resources } : task);
  }
  return { ...submission, tasks: sized };
}

/** The fields a task gets from its product, never from whoever submits it. */
const PRODUCT_FIELDS = ["tokenAudiences", "inputSchema", "outputSchema", "concurrencyKey", "productCap", "capacity", "approvalRequired"] as const;

/** What a product's actions share, for its cap: its catalog folder, or (registered by hand) its image's repository. */
function productScope(product: { sourcePath: string | null; image: string }): string {
  return product.sourcePath ? product.sourcePath.replace(/\/product\.yaml$/, "") : imageRepository(product.image);
}

const isReference = (value: unknown) =>
  isRecord(value) && Object.keys(value).length === 2 && "$fromTask" in value && "$output" in value;

const nonEmpty = (schema: unknown) => isRecord(schema) && Object.keys(schema).length > 0;

/**
 * The submission with what each task gets from its product (the one its
 * ServiceAccount runs), and none of it for anything else:
 *   - tokenAudiences, as product.yaml declares them: never the submitter's
 *     to choose, as its ServiceAccount isn't;
 *   - its input and output schemas, for the kernel to check the resolved
 *     inputs before it starts and its outputs when it finishes (C1).
 * Replaces whatever a task carries, so a stored submission rerun gets its
 * product's current ones. And the inputs known now (every one but an
 * upstream output's reference, which the kernel checks once resolved) are
 * checked against the input schema: all the problems refused together, as
 * INPUT_INVALID. Run after authorization, as withProductResources is.
 */
/**
 * The attempts a step of a registered product gets (R3): what its owner
 * allows, or fewer when the template or DAG asks for fewer; exactly one for
 * an action that isn't idempotent, since running it again could do its work
 * twice. A failure is retried only when it's marked retryable: a reclaimed
 * node, a lost Job, a timeout, or the product saying so.
 */
function attemptsFor(product: { idempotent: boolean; maxAttempts: number }, requested: unknown): number {
  const allowed = product.idempotent ? Math.max(1, product.maxAttempts) : 1;
  return typeof requested === "number" && Number.isInteger(requested) && requested >= 1 ? Math.min(requested, allowed) : allowed;
}

/** Who a run is by, for approvals: the caller's teams, and the team it's for. */
interface Runner {
  teamNames: string[];
  forTeam?: string | undefined;
  isAdmin?: boolean | undefined;
}

/**
 * Whether a step of `product`, in its team `team`, waits for a maintainer of
 * that team to approve it: always, if its product.yaml says so; for another
 * team's run (the caller isn't in the product's team), if it says
 * otherTeams, or names the team the run is for (approval as a list), or if
 * a target it's aimed at is one the team's allowedTargets let through only
 * with an approval (targets.ts).
 */
async function approvalRequired(product: Product, team: string, inputs: Record<string, unknown>, runner: Runner): Promise<boolean> {
  if (product.approval === "always") return true;
  if (runner.teamNames.includes(team)) return false;
  if (product.approval === "otherTeams") return true;
  const runFor = runner.forTeam ? [runner.forTeam] : runner.teamNames;
  if (runFor.some((t) => product.approvalTeams.includes(t))) return true;
  const owner = await findTeamByName(team);
  return owner !== undefined && targetsNeedApproval(owner, product.inputSchema, inputs, runner.forTeam ? [runner.forTeam] : runner.teamNames);
}

async function withProductContract(submission: Record<string, unknown>, runner: Runner): Promise<Record<string, unknown>> {
  const tasks = submission["tasks"];
  if (!Array.isArray(tasks)) return submission;
  const products = productLookup();
  const out: unknown[] = [];
  const problems: { field: string; message: string }[] = [];
  for (const task of tasks) {
    if (!isRecord(task)) {
      out.push(task);
      continue;
    }
    const rest = Object.fromEntries(Object.entries(task).filter(([key]) => !(PRODUCT_FIELDS as readonly string[]).includes(key)));
    const team = optionalString(task["team"]);
    const serviceAccount = optionalString(task["serviceAccount"]) ?? UNREGISTERED_SERVICE_ACCOUNT;
    const product = team === undefined ? undefined : await products.forContract(team, optionalString(task["image"]), optionalString(task["action"]), serviceAccount);
    // Its identity's own (the tokens it's given) only when it runs as the
    // product's release and ServiceAccount; its rules and limits whatever.
    const asProduct = product !== undefined && team !== undefined &&
      (await products.matching(team, optionalString(task["image"]), optionalString(task["action"]))).some((p) => p.id === product.id && runsAs(p) === serviceAccount);
    if (!product) {
      out.push(rest);
      continue;
    }
    // Not for this install's cloud: nothing runs.
    ensureRunsHere(product);
    // A target another step will fill: limited, for the kernel, to what the
    // product's team lets this run's team use (targets.ts), unless it's
    // the team's own run, or an admin's.
    let inputSchema = product.inputSchema;
    if (team !== undefined && !runner.isAdmin && !runner.teamNames.includes(team)) {
      const owner = await findTeamByName(team);
      if (owner) {
        const narrowed = narrowWiredTargets(owner, product.inputSchema, isRecord(task["inputs"]) ? task["inputs"] : {}, runner.forTeam ? [runner.forTeam] : runner.teamNames);
        inputSchema = narrowed.schema;
        for (const r of narrowed.refused) {
          problems.push({
            field: `tasks.${String(task["id"])}.inputs.${r.field}`,
            message: `comes from another step, but ${team} lets your team aim this at no ${r.kind} without an approval: give it a value instead`,
          });
        }
      }
    }
    if (nonEmpty(product.inputSchema)) {
      const inputs = isRecord(task["inputs"]) ? task["inputs"] : {};
      const references = new Set(Object.keys(inputs).filter((key) => isReference(inputs[key])));
      const known = Object.fromEntries(Object.entries(inputs).filter(([key]) => !references.has(key)));
      for (const e of schemaErrors(product.inputSchema, known)) {
        const missing = e.keyword === "required" ? String((e.params as { missingProperty?: unknown }).missingProperty) : undefined;
        if (missing !== undefined && references.has(missing)) continue; // an upstream output, checked when resolved
        problems.push({ field: `tasks.${String(task["id"])}.inputs${errorPath(e)}`, message: errorMessage(e) });
      }
    }
    out.push({
      ...rest,
      maxAttempts: attemptsFor(product, task["maxAttempts"]),
      ...(asProduct && product.tokenAudiences.length > 0 ? { tokenAudiences: product.tokenAudiences } : {}),
      ...(nonEmpty(inputSchema) ? { inputSchema } : {}),
      ...(nonEmpty(product.outputSchema) ? { outputSchema: product.outputSchema } : {}),
      // One step per set of these inputs' values at a time, the product's
      // own (the kernel works the key out once the inputs are resolved).
      ...(product.concurrencyKey.length > 0 ? { concurrencyKey: { scope: product.name, inputs: product.concurrencyKey } } : {}),
      // At most so many of the product's steps at once, all its actions
      // sharing it: scoped to its folder in the catalog, else its image.
      ...(product.maxRunning > 0 ? { productCap: { scope: productScope(product), maxRunning: product.maxRunning } } : {}),
      // Spot or on-demand, the product's own; the install places it.
      ...(product.capacity ? { capacity: product.capacity } : {}),
      ...((await approvalRequired(product, team ?? "", isRecord(task["inputs"]) ? task["inputs"] : {}, runner))
        ? { approvalRequired: true }
        : {}),
    });
  }
  if (problems.length > 0) {
    throw new ApiError(
      422,
      "INPUT_INVALID",
      `Inputs that don't fit their product's input schema: ${problems.map((p) => `${p.field} ${p.message}`).join("; ")}.`,
      undefined,
      { problems },
    );
  }
  return { ...submission, tasks: out };
}

/** A submission as recorded: without the products' schemas, which a rerun gets afresh. */
function recordable(submission: Record<string, unknown>): Record<string, unknown> {
  const tasks = submission["tasks"];
  if (!Array.isArray(tasks)) return submission;
  return {
    ...submission,
    tasks: tasks.map((task: unknown) =>
      isRecord(task) ? Object.fromEntries(Object.entries(task).filter(([key]) => key !== "inputSchema" && key !== "outputSchema")) : task,
    ),
  };
}

/**
 * Help for each failed task: what its error means and what to do, from its
 * product's owner when they said, whether a retry is safe, and whom to ask
 * (failureHelp.ts). Its product is found from the task as submitted.
 */
async function failuresExplained(
  tasks: { taskId: string; failure: Record<string, unknown> | null }[],
  payload: unknown,
): Promise<Map<string, FailureHelp>> {
  const out = new Map<string, FailureHelp>();
  const submitted = new Map<string, Record<string, unknown>>();
  const list = isRecord(payload) && Array.isArray(payload["tasks"]) ? payload["tasks"] : [];
  for (const task of list) if (isRecord(task) && typeof task["id"] === "string") submitted.set(task["id"], task);
  const products = productLookup();
  for (const t of tasks) {
    const code = typeof t.failure?.["code"] === "string" ? t.failure["code"] : undefined;
    if (!code) continue;
    const task = submitted.get(t.taskId);
    const product = await productOfTask(products, task, { anyDigest: true });
    const teamName = optionalString(task?.["team"]);
    const team = teamName ? await findTeamByName(teamName) : undefined;
    out.set(t.taskId, failureHelp(code, product, team));
  }
  return out;
}

/** Who asked, as the kernel records it on attempts. */
function requester(caller: AuthUser | undefined): string {
  return caller?.id ? `user:${caller.id}` : "";
}

/**
 * The checks every submission gets: a maintainer of each task's team (except
 * for a template's run, authorized as a whole by core/templates.ts), then
 * authorizeIdentities. Rerun and retry apply them afresh against current
 * membership and grants, rather than trusting what was true at the first
 * submission (a team can lose a secret, or a caller leave a team, in
 * between). The images must be pinned by now: a product's identity is its
 * released digests'.
 */
async function authorizeTasks(
  tasksInfo: TaskAuthInfo[],
  caller: AuthUser | undefined,
  { maintainers = true }: { maintainers?: boolean } = {},
): Promise<void> {
  await authorizeTeams(tasksInfo, caller, { maintainers });
  await authorizeIdentities(tasksInfo);
}

/** A maintainer of each task's team (unless `maintainers` is false), and each team able to run anything. */
async function authorizeTeams(
  tasksInfo: TaskAuthInfo[],
  caller: AuthUser | undefined,
  { maintainers = true }: { maintainers?: boolean } = {},
): Promise<void> {
  const uniqueTeams = [...new Set(tasksInfo.map((t) => t.team))];
  for (const team of uniqueTeams) {
    // A template's run is authorized as a whole instead (core/templates.ts):
    // its steps run in their products' teams, which the consumer isn't in.
    if (maintainers) ensureTeamMaintainer(caller, team);
    const blocker = await teamRunBlocker(team);
    if (blocker) throw blocked(409, blocker);
  }
}

/**
 * The identity each task runs as (identityRefusal), then secretRefs against
 * each team's current secrets. Run on pinned images.
 */
async function authorizeIdentities(tasksInfo: TaskAuthInfo[]): Promise<void> {
  // kernel runs a task as whatever ServiceAccount, and mounts whatever
  // Secret names, it asks for, with no notion of "team" or "product" to
  // check them against (kernel/internal/executor/kubernetes.go): this is the one
  // place that's enforced before dispatch, as team membership above (the
  // cluster's identity policy checks again).
  const products = productLookup();

  // Which ServiceAccount, and which secrets, follow from the product release
  // the task runs (identityRefusal).
  for (const task of tasksInfo) {
    const matching = await products.matching(task.team, task.image, task.action);
    const unreleased = matching.length === 0 ? await products.sameRepository(task.team, task.image, task.action) : [];
    const refusal = identityRefusal(task, matching, unreleased);
    if (refusal) throw new ApiError(403, "FORBIDDEN", refusal);
  }

  // And each secret must be one its team registered. Any of the team's
  // products may mount any of them (only products get this far with
  // secrets); the cluster's identity policy holds the same list.
  for (const { team, secretRefs } of tasksInfo) {
    if (secretRefs.length === 0) continue;
    const teamId = await products.teamId(team);
    if (!teamId) throw new ApiError(422, "UNPROCESSABLE_ENTITY", `Team "${team}" does not exist.`);
    for (const secretName of secretRefs) {
      if (!(await isSecretRegistered(teamId, secretName))) {
        throw new ApiError(
          403,
          "FORBIDDEN",
          `Secret "${secretName}" is not registered for team "${team}". Add it on the team's Secrets tab.`,
        );
      }
    }
  }
}

/**
 * Makes sure the cluster's identity policy lists the release each task runs
 * as its product (productPolicy.ts), before kernel-api has the steps: each
 * is marked used, so it stays listed until the execution is recorded (and
 * in use), and written into the policy if it isn't yet. Run after
 * authorizeIdentities.
 */
async function admitIdentities(tasksInfo: TaskAuthInfo[]): Promise<void> {
  const products = productLookup();
  const uses: { productId: string; digest: string; team: string; repository: string; action: string; serviceAccount: string }[] = [];
  // The ones the cluster would refuse unless they're listed: as another
  // ServiceAccount than default, or with Secrets or tokens (default with
  // none runs as any image may).
  const needed: typeof uses = [];
  for (const task of tasksInfo) {
    const digest = task.image === undefined ? null : digestOf(task.image);
    if (!digest || task.image === undefined) continue;
    const serviceAccount = task.serviceAccount ?? UNREGISTERED_SERVICE_ACCOUNT;
    const product = (await products.matching(task.team, task.image, task.action)).find((p) => runsAs(p) === serviceAccount);
    if (!product) continue;
    const use = { productId: product.id, digest, team: task.team, repository: imageRepository(task.image), action: product.action, serviceAccount };
    uses.push(use);
    if (serviceAccount !== UNREGISTERED_SERVICE_ACCOUNT || task.secretRefs.length > 0 || product.tokenAudiences.length > 0) needed.push(use);
  }
  if (uses.length === 0) return;
  // With a signed catalog, the kernel's policy decides too (catalogPolicy.ts):
  // a release it doesn't list would be refused at dispatch. First, so a
  // refused submission marks nothing used.
  const pending = await unlistedByKernel(needed);
  if (pending.length > 0) {
    throw new ApiError(
      409,
      "IDENTITY_PENDING",
      `The kernel's policy doesn't list ${pending.join(", ")} as its product's release, from the catalog's signed release. ` +
        "If that release is new, the kernel reads the catalog every minute or so: try again shortly. An earlier " +
        "release stays listed only for an hour after a newer one replaced it, or while a step runs it: run the " +
        "current one. A product registered by hand, not released through the catalog, runs as its product only " +
        "with an unsigned catalog (or as default, with no Secrets).",
    );
  }
  await markReleasesUsed(uses);
  const unlisted = await admitReleases(uses);
  if (unlisted.length > 0) {
    throw new ApiError(
      409,
      "IDENTITY_PENDING",
      `The product released as ${unlisted.join(", ")} changed while this was being submitted; try again.`,
    );
  }
}

/**
 * kernel-api's requestIds are one namespace for every team, so two teams
 * picking the same one ("hello-1") would get each other's executions back.
 * Prefixing it with the submitting teams keeps each team's requestIds its
 * own, while a retry from the same team still matches. Absent stays absent:
 * kernel-api then starts a new execution every time.
 */
function scopeRequestId(submission: Record<string, unknown>, teams: string[]): Record<string, unknown> {
  const requestId = submission["requestId"];
  if (typeof requestId !== "string" || requestId === "") return submission;
  return { ...submission, requestId: `${[...teams].sort().join("+")}/${requestId}` };
}

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1000;

export const ListQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
  cursor: Type.Optional(Type.String({ maxLength: 120 })),
  since: Type.Optional(Type.String({ format: "date-time" })),
  team: Type.Optional(Type.String({ minLength: 1 })),
  search: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  mine: Type.Optional(Type.Boolean()),
});
export const ExecutionId = Type.String({ format: "uuid" });

/** A run in one of these has finished: its last change is when. */
const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/**
 * The executions the caller can see, newest first, a page at a time. Their
 * state is enrichment from kernel-api for just this page: if kernel-api is
 * briefly unreachable the list still comes back, without states, rather
 * than failing over one non-critical field.
 */
export async function listExecutions(
  caller: AuthUser | undefined,
  query: {
    limit?: number | undefined;
    cursor?: string | undefined;
    since?: string | undefined;
    team?: string | undefined;
    search?: string | undefined;
    /** Only the caller's own runs. */
    mine?: boolean | undefined;
  },
  log: FastifyBaseLogger,
) {
  const { limit = DEFAULT_PAGE_SIZE, cursor, since, team, search, mine } = query;
  let page;
  try {
    page = await listSubmittedExecutionsPage({
      visibleTo: caller?.isAdmin ? null : (caller?.teamNames ?? []),
      // A consumer's own runs, in teams they aren't in (core/templates.ts).
      visibleToUser: caller?.id,
      limit,
      cursor,
      since: since === undefined ? undefined : new Date(since),
      team,
      search,
      submittedBy: mine ? (caller?.id ?? "") : undefined,
    });
  } catch (error) {
    if (error instanceof InvalidCursorError) throw new ApiError(400, "BAD_REQUEST", error.message);
    throw error;
  }
  let statesByExecutionId = new Map<string, ExecutionStateEntry>();
  try {
    const states = await getExecutionStates(
      page.rows.map((row) => row.executionId),
      { running: true },
    );
    statesByExecutionId = new Map(states.map((s) => [s.executionId, s]));
  } catch (error) {
    log.warn({ err: error }, "Failed to fetch execution states from kernel-api");
  }
  return {
    executions: page.rows.map((row) => {
      const kernel = statesByExecutionId.get(row.executionId);
      const finished = kernel && TERMINAL_STATES.has(kernel.state);
      return {
        ...row,
        state: kernel?.state ?? null,
        steps: kernel?.steps ?? {},
        running: kernel?.running ?? [],
        finishedAt: finished && kernel.updatedAt ? new Date(kernel.updatedAt) : null,
      };
    }),
    nextCursor: page.nextCursor,
    // Anyone signed in may know how long runs are kept (the Runs page says so).
    runRetentionDays: config.retention.executionDays,
  };
}

/**
 * Checks and submits a DAG (any JSON: the checks need only each task's team,
 * image, action, ServiceAccount and secrets). Returns whether kernel-api
 * created it, or found the one its requestId already started.
 */
export async function submit(caller: AuthUser | undefined, submitted: unknown, log: FastifyBaseLogger) {
  ensureMayOrder(caller);
  return submitChecked(caller, submitted, log);
}

/** What a run of a template records (core/templates.ts). */
/** What submitted_executions.template says for a cleanup run (core/resources.ts): never a template's <team>/<name>. */
export const CLEANUP_RUN = "cleanup";

export interface TemplateRun {
  /** <team>/<template>, or <team>/<product>.<action> for an action run alone. */
  template: string;
  parameters: Record<string, unknown>;
  onBehalfOf: string | undefined;
  /**
   * The team each step runs for, by its id, when that isn't onBehalfOf: a
   * cleanup's, the team what it deletes was made for; an approver's
   * preview, the team the step it previews runs for.
   */
  forTeams?: Record<string, string> | undefined;
  /** The schedule that started it (scheduler.ts). */
  scheduleId?: string | undefined;
}

/**
 * The submission with each task's forTeam, the team it runs for
 * (request.json's forTeam, which a product marks what it makes with, and
 * cleans up only that team's): a run's forTeams or onBehalfOf; for a run
 * for its person alone, the task's own team when the caller is in it, else
 * none; a team's own DAG, the task's team, whose member submits it. Never
 * the submitter's to choose: whatever a task carries is replaced.
 */
function withForTeam(submission: Record<string, unknown>, caller: AuthUser | undefined, run: TemplateRun | undefined): Record<string, unknown> {
  const tasks = submission["tasks"];
  if (!Array.isArray(tasks)) return submission;
  return {
    ...submission,
    tasks: tasks.map((task: unknown) => {
      if (!isRecord(task)) return task;
      const rest = Object.fromEntries(Object.entries(task).filter(([key]) => key !== "forTeam"));
      const team = optionalString(task["team"]);
      const id = optionalString(task["id"]);
      const forTeam =
        run === undefined
          ? team
          : ((id !== undefined ? run.forTeams?.[id] : undefined) ?? run.onBehalfOf ?? (team !== undefined && caller?.teamNames.includes(team) ? team : undefined));
      return forTeam ? { ...rest, forTeam } : rest;
    }),
  };
}

/**
 * Checks and submits a DAG. A template's run (`run`) is built by
 * core/templates.ts from products and already authorized, so it skips team
 * membership and nothing else; its requestId is scoped to the person, who
 * may not be in any of its teams.
 */
export async function submitChecked(
  caller: AuthUser | undefined,
  submitted: unknown,
  log: FastifyBaseLogger,
  run?: TemplateRun,
) {
  const malformed = () =>
    new ApiError(
      400,
      "BAD_REQUEST",
      'Malformed submission: every task must declare a non-empty "team", and ' +
        '"secretRefs" if present must be an array of non-empty strings.',
    );
  const submittedInfo = extractTasksAuthInfo(submitted);
  if (submittedInfo === null) throw malformed();
  await authorizeTeams(submittedInfo, caller, { maintainers: run === undefined });
  await refuseRetiredFor(caller, [run?.onBehalfOf, ...Object.values(run?.forTeams ?? {})], {
    adminCleanup: caller?.isAdmin === true && run?.template === CLEANUP_RUN,
  });
  const teams = [...new Set(submittedInfo.map((t) => t.team))];
  const context: RunContext = { action: "submit", teams, caller, log };
  await refuseBlockedImages(taskImages(submitted), context);

  // Pinned before the identity checks: a product's identity is its
  // released digests' (productPolicy.ts), so it follows from the image that
  // will run, not from a tag.
  const pinnedBody = await withProductIdentities(await pinned(submitted as Record<string, unknown>, context));
  const tasksInfo = extractTasksAuthInfo(pinnedBody);
  if (tasksInfo === null) throw malformed();
  await authorizeIdentities(tasksInfo);
  await ensureServiceAccounts(tasksInfo);
  await refuseUnscanned(taskImages(pinnedBody), context);
  await admitIdentities(tasksInfo);
  const submission = withForTeam(
    await withProductContract(await withProductResources(pinnedBody), {
      teamNames: caller?.teamNames ?? [],
      forTeam: run?.onBehalfOf,
      isAdmin: caller?.isAdmin,
    }),
    caller,
    run,
  );

  // Before the kernel has it: once it does, nothing may stand between it
  // and its record (recordOrCancel), or it would run unrecorded.
  const excluded = await notDeciders(caller?.id ?? null);
  const result = await submitExecution(scopeRequestId(submission, run ? [`user:${caller?.id ?? ""}`] : teams), requester(caller));
  await recordOrCancel(
    {
      executionId: result.executionId,
      teams,
      submittedBy: caller?.id ?? null,
      notDeciders: excluded,
      name: typeof submission["name"] === "string" ? submission["name"] : "",
      payload: recordable(submission),
      template: run?.template,
      templateParameters: run?.parameters,
      onBehalfOf: run?.onBehalfOf,
      scheduleId: run?.scheduleId,
    },
    result.created,
    log,
  );
  return { executionId: result.executionId, state: result.state, created: result.created };
}

/**
 * An execution and its tasks, live, enriched with what the console knows and
 * kernel-api doesn't: its teams, who submitted it, the DAG as submitted
 * (payload), and why a rerun or retry would be refused right now
 * (runBlocked, the same check they enforce).
 */
export async function executionDetail(caller: AuthUser | undefined, executionId: string, log: FastifyBaseLogger) {
  const submitted = await loadExecution(executionId, caller, "any");
  const detail = await getExecution(executionId);
  // No submitter id: that account has since been deleted (its executions
  // are kept, see db/schema.ts).
  const submitter = submitted.submittedBy ? await findUserById(submitted.submittedBy) : undefined;
  const blocker =
    (await runBlocker([...submitted.teams, ...(submitted.onBehalfOf ? [submitted.onBehalfOf] : [])])) ??
    (await detailImageBlocker(submitted.payload, log));
  // Who asked for each attempt, as the kernel recorded it: "user:<id>",
  // shown by email (an account since deleted says so).
  const emails = new Map<string, string>();
  const askers = detail.tasks.flatMap((t) => [...t.attempts.map((a) => a.requestedBy), t.approvedBy]);
  for (const id of new Set(askers.filter((r) => r.startsWith("user:")))) {
    emails.set(id, (await findUserById(id.slice("user:".length)))?.email ?? "(deleted account)");
  }
  const helped = await failuresExplained(detail.tasks, submitted.payload);
  const teamOf = taskTeams(submitted.payload);
  const excluded = detail.tasks.some((t) => t.state === "AWAITING_APPROVAL") ? await notDecidersOf(submitted) : [];
  const deciding = (t: { taskId: string; state: string }) =>
    t.state === "AWAITING_APPROVAL" && caller !== undefined && mayDecide(caller, teamOf.get(t.taskId) ?? "", excluded);
  // Who may decide on a waiting step can preview it, when its product has a plan.
  const previewable = new Set<string>();
  const products = productLookup();
  for (const t of detail.tasks.filter(deciding)) {
    const task = payloadTask(submitted.payload, t.taskId);
    if ((await productOfTask(products, task))?.plan) previewable.add(t.taskId);
  }
  // A provider's member sees only their own steps in full (runView.ts).
  const view = runView(caller, submitted);
  return {
    ...detail,
    tasks: detail.tasks.map((t) => ({
      ...t,
      ...(view.sees(t.taskId) ? {} : { outputs: null, failure: failureCodeOnly(t.failure), waitingFor: null }),
      attempts: t.attempts.map((a) => ({
        ...a,
        requestedBy: emails.get(a.requestedBy) ?? "",
        ...(view.sees(t.taskId) ? {} : { failure: failureCodeOnly(a.failure) }),
      })),
      help: helped.get(t.taskId) ?? null,
      approval: t.approvalRequired
        ? {
            approvedBy: emails.get(t.approvedBy) ?? "",
            approvedAt: t.approvedAt,
            awaitingSince: t.awaitingSince,
            canDecide: deciding(t),
            canPreview: previewable.has(t.taskId),
          }
        : null,
    })),
    teams: submitted.teams,
    // A readiness check is the console's own run: no account submitted it.
    submittedBy: submitter?.email ?? (submitted.template === CHECK_RUN ? "the readiness check" : submitted.submittedBy === null ? "(deleted account)" : null),
    createdAt: submitted.createdAt,
    payload: visiblePayload(submitted.payload, view),
    runBlocked: blocker,
    template: submitted.template,
    // The consumer's parameters, theirs to see.
    templateParameters: view.full ? submitted.templateParameters : null,
    onBehalfOf: submitted.onBehalfOf,
    schedule: await scheduleThatStarted(executionId),
  };
}

export async function executionEvents(caller: AuthUser | undefined, executionId: string, after: number | undefined) {
  const submitted = await loadExecution(executionId, caller, "any");
  const view = runView(caller, submitted);
  const page = await getExecutionEvents(executionId, after);
  return { ...page, events: page.events.map((event) => visibleEvent(event, view)) };
}

/**
 * Every step's captured output, as the caller may see it: everything for
 * the step's team and admins, only its INFO lines for the run's other
 * owners (logLevels.ts), and nothing for a provider's member outside their
 * own steps (runView.ts).
 */
export async function executionLogs(caller: AuthUser | undefined, executionId: string) {
  const submitted = await loadExecution(executionId, caller, "any");
  const teams = taskTeams(submitted.payload);
  const view = runView(caller, submitted);
  const logs = await getExecutionLogs(executionId);
  return {
    tasks: logs.tasks.map((t) => {
      const team = teams.get(t.taskId) ?? "";
      const seesEverything = caller?.isAdmin === true || (caller?.teamNames ?? []).includes(team);
      const shown = view.sees(t.taskId) ? visibleLines(t.lines, seesEverything) : { lines: [], hidden: t.lines.length };
      return { taskId: t.taskId, ...shown, visibleTo: team };
    }),
  };
}

/** Every team, as for submitting it: cancelling stops all of its tasks, other teams' too. */
export async function cancel(caller: AuthUser | undefined, executionId: string) {
  await loadExecution(executionId, caller, "every");
  return cancelExecution(executionId);
}

/**
 * Retries a failed task, with the same checks as a rerun, against current
 * membership and grants, over every task: retrying resumes the whole
 * execution, and kernel-api then revives the tasks the failure cancelled,
 * other teams' too, each mounting its secrets again.
 */
export async function retry(caller: AuthUser | undefined, executionId: string, taskId: string, log: FastifyBaseLogger) {
  const submitted = await loadExecution(executionId, caller, "any");
  const tasksInfo = submitted.payload === null ? null : extractTasksAuthInfo(submitted.payload);
  if (tasksInfo === null) {
    throw new ApiError(
      422,
      "UNPROCESSABLE_ENTITY",
      "This execution has no stored submission (it predates them, or it's malformed), " +
        "so there's nothing to check a retry's access against.",
    );
  }
  // A consumer retries their own run of a template without being in its
  // teams; anyone else as for any execution.
  const ownTemplateRun = submitted.template !== null && caller?.id !== undefined && submitted.submittedBy === caller.id;
  // Theirs only while it's still shared with them, and its steps with its team.
  if (ownTemplateRun) await ensureStillRunnable(caller, submitted);
  await authorizeTasks(tasksInfo, caller, { maintainers: !ownTemplateRun });
  // An admin's cleanup run may be retried as it may run (refuseRetiredFor).
  await refuseRetiredFor(caller, [submitted.onBehalfOf, ...taskForTeams(submitted.payload)], {
    adminCleanup: caller?.isAdmin === true && submitted.template === CLEANUP_RUN,
  });
  // What runs again: the step, and every step kernel-api revives with it,
  // the ones its failure cancelled. Read before the retry, so every step not
  // yet finished is counted (a running one may be cancelled before the retry
  // lands); each is held to what a new one would be.
  const finished = new Set(["SUCCEEDED", "FAILED"]);
  const unfinished = (await getExecution(executionId)).tasks.filter((t) => !finished.has(t.state)).map((t) => t.taskId);
  const runAgain = new Set([taskId, ...unfinished]);
  const products = productLookup();
  for (const id of runAgain) {
    await ensureRetryTargetsAllowed(caller, submitted, id);
    // Its product may since have been made for other clouds' installs.
    const product = await productOfTask(products, payloadTask(submitted.payload, id), { contract: true });
    if (product) ensureRunsHere(product);
  }
  const images = [...runAgain].flatMap((id) => taskImages(submitted.payload, id));
  const context: RunContext = { action: "retry", teams: submitted.teams, executionId, caller, log };
  await refuseBlockedImages(images, context);
  await refuseUnscanned(images, context);
  await ensureServiceAccounts(tasksInfo);
  await admitIdentities(tasksInfo.filter((task) => task.id !== undefined && runAgain.has(task.id)));
  const retried = await retryTask(executionId, taskId, requester(caller));
  // Live again: what it makes, or deletes, is recorded once it finishes again.
  await markResourcesUnrecorded(executionId);
  return retried;
}

/**
 * Refuses retrying a step aimed at a target its product's team no longer
 * lets the run's team use (X1): its allowedTargets may have narrowed since
 * the run started, and a retry runs the step again against the same target.
 * The product team's own people, and admins, aren't limited, as when it ran.
 */
async function ensureRetryTargetsAllowed(caller: AuthUser | undefined, submitted: SubmittedExecution, taskId: string): Promise<void> {
  if (!caller || caller.isAdmin) return;
  const task = payloadTask(submitted.payload, taskId);
  const product = await productOfTask(productLookup(), task, { contract: true });
  const owner = product?.teamId ? await findTeamById(product.teamId) : undefined;
  if (!product || !owner || caller.teamNames.includes(owner.name)) return;
  const inputs = isRecord(task?.["inputs"]) ? task["inputs"] : {};
  const teams = submitted.onBehalfOf ? [submitted.onBehalfOf] : caller.teamNames;
  const problems = targetProblems(owner, product.inputSchema, inputs, teams);
  if (problems.length === 0) return;
  throw new ApiError(
    403,
    "TARGET_NOT_ALLOWED",
    `Step "${taskId}" can't be retried: ${problems.map((p) => p.message).join(" ")}`,
    undefined,
    { problems: problems.map((p) => ({ field: `inputs.${p.field}`, message: p.message })) },
  );
}

/**
 * Resubmits an execution's exact task graph as a new execution (a fresh id:
 * kernel-api has no "run this again in place"; attempts and outputs are
 * append-only history). The same checks as a submission, against current
 * state, since membership or grants can have changed since.
 */
export async function rerun(caller: AuthUser | undefined, executionId: string, log: FastifyBaseLogger) {
  ensureMayOrder(caller); // an ordering bot places a new order instead
  const submitted = await loadExecution(executionId, caller, "any");
  if (submitted.payload === null || submitted.payload === undefined) {
    throw new ApiError(
      422,
      "UNPROCESSABLE_ENTITY",
      "This execution was submitted before rerun support existed, so there's no stored submission to replay.",
    );
  }
  // A template's run is rerun as the template, against its current products,
  // with its parameters: only by its owners (runView), who see them. A
  // provider of one of its steps sees the run, not them, and rerunning it
  // would make a run of their own with them.
  if (submitted.template !== null) {
    if (!runView(caller, submitted).full) {
      throw new ApiError(403, "FORBIDDEN", "Only this run's owners rerun it: whoever ran it, the team it was run for, or an admin.");
    }
    return rerunTemplate(caller, submitted, log);
  }
  const malformed = () => new ApiError(422, "UNPROCESSABLE_ENTITY", "The stored submission for this execution is malformed and can't be replayed.");
  const storedInfo = extractTasksAuthInfo(submitted.payload);
  if (storedInfo === null) throw malformed();
  await authorizeTeams(storedInfo, caller);
  await refuseRetiredFor(caller, []);
  const context: RunContext = { action: "rerun", teams: submitted.teams, executionId, caller, log };
  await refuseBlockedImages(taskImages(submitted.payload), context);

  // Every field carries over except requestId: kernel-api treats it as
  // identifying this specific submission (proto/vennir/kernel/v1),
  // so reusing the original would return the same execution. A stored DAG
  // from before pinning has tags; they're pinned now, before the identity
  // checks (a product's identity is its released digests'). A task with no
  // serviceAccount gets the one it runs as now.
  const pinnedReplay = await withProductIdentities(await pinned(submitted.payload as Record<string, unknown>, context));
  const tasksInfo = extractTasksAuthInfo(pinnedReplay);
  if (tasksInfo === null) throw malformed();
  await authorizeIdentities(tasksInfo);
  await ensureServiceAccounts(tasksInfo);
  await refuseUnscanned(taskImages(pinnedReplay), context);
  await admitIdentities(tasksInfo);
  // A team's own DAG again: each step for its team, whatever the stored one says.
  const rerunPayload = withForTeam(
    await withProductContract(await withProductResources({ ...pinnedReplay, requestId: randomUUID() }), {
      teamNames: caller?.teamNames ?? [],
      forTeam: submitted.onBehalfOf ?? undefined,
      isAdmin: caller?.isAdmin,
    }),
    caller,
    undefined,
  );

  const excluded = await notDeciders(caller?.id ?? null); // before the kernel has it (see submitChecked)
  const result = await submitExecution(scopeRequestId(rerunPayload, submitted.teams), requester(caller));
  await recordOrCancel(
    {
      executionId: result.executionId,
      teams: submitted.teams,
      submittedBy: caller?.id ?? "",
      notDeciders: excluded,
      name: submitted.name,
      payload: recordable(rerunPayload),
    },
    result.created,
    log,
  );
  return { executionId: result.executionId, state: result.state };
}
