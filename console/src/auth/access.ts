// SPDX-License-Identifier: MIT
/**
 * Who may act for a team, and who may see or manage an execution: the
 * console's authorization rules, in one place. kernel-api knows nothing of
 * teams, so these checks are what keep one team out of another's work.
 *
 * A team's people are maintainers or members (team_memberships.role). Any
 * member sees the team's work (executions, logs, Pods, its secrets' names)
 * and runs what it may run; a maintainer also manages the team: members
 * and roles, secrets, bots, raw DAGs and cancelling its runs. Everyone
 * signed in is a consumer of what's shared with their teams
 * (core/templates.ts). A platform admin may do all of it for any team.
 */
import { findSubmittedExecution, type SubmittedExecution } from "../db/queries.js";
import { ApiError } from "../apiError.js";

/** What the checks need of the caller (request.authUser). */
type AuthUser = { id?: string; teamNames: string[]; maintainerOf?: string[]; isAdmin: boolean } | undefined;

/**
 * An ordering bot (decision 23) may run its listed templates and nothing
 * else: throws when `template` (<team>/<name>) isn't one of them, or, with
 * none, when the caller is an ordering bot at all (a raw DAG, a single
 * action, a rerun). Anyone else may.
 */
export function ensureMayOrder(authUser: { orderTemplates?: string[] } | undefined, template?: string): void {
  const list = authUser?.orderTemplates;
  if (!list) return;
  if (template === undefined) {
    throw new ApiError(403, "ORDERS_ONLY", "This bot places orders: it may only run the templates listed for it.");
  }
  if (!list.includes(template)) {
    throw new ApiError(403, "TEMPLATE_NOT_ORDERABLE", `This bot may not order ${template}: its team's maintainers list what it may order.`);
  }
}

/**
 * A bot (a pipeline's, an ordering one, a keyless CI job's) acts with what
 * its team gave it and gives nothing on: it makes no tokens, identities or
 * bots, and changes no one's membership or the team's sign-in. A keyless
 * session lasts an hour, and a token it made would outlast it.
 */
export function ensureNotBot(authUser: { isBot?: boolean } | undefined, what: string): void {
  if (authUser?.isBot) {
    throw new ApiError(403, "FORBIDDEN", `A bot can't ${what}: a person who maintains the team does.`);
  }
}

/** A member of the team, or a platform admin. */
export function canActForTeam(authUser: AuthUser, team: string): boolean {
  return authUser !== undefined && (authUser.isAdmin || authUser.teamNames.includes(team));
}

/** Throws the 403 (ApiError) when the caller can't act for `team`. */
export function ensureTeamMember(authUser: AuthUser, team: string): void {
  if (!canActForTeam(authUser, team)) {
    throw new ApiError(403, "FORBIDDEN", `Not a member of team "${team}", and not a platform admin.`);
  }
}

/** A maintainer of the team, or a platform admin. */
export function canMaintainTeam(authUser: AuthUser, team: string): boolean {
  return authUser !== undefined && (authUser.isAdmin || (authUser.maintainerOf ?? []).includes(team));
}

/** Throws the 403 (ApiError) when the caller can't manage `team`. */
export function ensureTeamMaintainer(authUser: AuthUser, team: string): void {
  if (!canMaintainTeam(authUser, team)) {
    const why = canActForTeam(authUser, team) ? "a member, not a maintainer," : "not a maintainer";
    throw new ApiError(403, "FORBIDDEN", `Managing team "${team}" takes a maintainer; you're ${why} and not a platform admin.`);
  }
}

/**
 * The submitted execution, when the caller may see it ("any" of its teams)
 * or manage it ("every" one: cancelling or retrying acts on all its teams'
 * tasks); otherwise its refusal (ApiError): 404 for no such execution, 403
 * for one the caller can't see or manage.
 */
export async function loadExecution(
  executionId: string,
  authUser: AuthUser,
  need: "any" | "every",
): Promise<SubmittedExecution> {
  const submitted = await findSubmittedExecution(executionId);
  if (!submitted) throw new ApiError(404, "NOT_FOUND", "Execution not found.");
  const member = (team: string) => canActForTeam(authUser, team);
  const maintainer = (team: string) => canMaintainTeam(authUser, team);
  // Whoever ran a template, too: a consumer who ran another team's template
  // sees, cancels and retries that run (core/templates.ts). A DAG submitted
  // as such stays its teams': cancelling it stops all of their tasks.
  const own = submitted.template !== null && authUser?.id !== undefined && submitted.submittedBy === authUser.id;
  // An execution always has a team; without one, "every" would hold for anyone.
  const allowed =
    own ||
    (need === "any" ? submitted.teams.some(member) : submitted.teams.length > 0 && submitted.teams.every(maintainer));
  if (!allowed) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      need === "any"
        ? "Not a member of any team this execution belongs to, and not a platform admin."
        : "Not a maintainer of every team this execution belongs to, and not a platform admin.",
    );
  }
  return submitted;
}
