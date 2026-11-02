// SPDX-License-Identifier: MIT
/** TeamService (proto/vertra/console/v1/team.proto): core/teams.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import {
  addMember,
  allTeams,
  applySecretStore,
  ensureTeam,
  MemberEmail,
  MemberId,
  members,
  newTeam,
  purgeTeam,
  removeMember,
  retireTeam,
  SecretStoreCredential,
  SecretStoreDocuments,
  setMemberRole,
  setSecretStoreCredential,
  setTeamSignIn,
  setTeamQuota,
  teamPods,
  teamProfile,
  teamSummaries,
  teamRecord,
  TeamName,
  unretireTeam,
} from "../../core/teams.js";
import { TaskPodState, TeamRole, type TeamService } from "../../gen/vertra/console/v1/team_pb.js";
import type { TeamRole as Role } from "../../db/schema.js";
import { timestamp } from "../convert.js";
import { callerOf, logOf } from "../context.js";
import { badRequest } from "../errors.js";
import { FixedWindowLimit } from "../rateLimit.js";
import { check } from "../validate.js";
import type { TeamQuota } from "../../k8s.js";
import { effectiveQuota } from "../../teamQuota.js";
import { config } from "../../config.js";

const AnyTeam = Type.String({ minLength: 1 });

const toRole = { maintainer: TeamRole.MAINTAINER, member: TeamRole.MEMBER } as const;

/** The role asked for; `whenUnspecified` (adding someone), or a refusal. */
function roleOf(role: TeamRole, whenUnspecified?: Role): Role {
  if (role === TeamRole.MAINTAINER) return "maintainer";
  if (role === TeamRole.MEMBER) return "member";
  if (whenUnspecified) return whenUnspecified;
  throw badRequest("Maintainer or member.", "role");
}

// "No such user" tells a member whether an email has an account, which
// adding by email can't avoid: limited per caller.
const addMemberLimit = new FixedWindowLimit(30, 60 * 60 * 1000);

const POD_STATE: Record<string, TaskPodState> = {
  starting: TaskPodState.STARTING,
  running: TaskPodState.RUNNING,
  "cant-start": TaskPodState.CANT_START,
  finished: TaskPodState.FINISHED,
  failed: TaskPodState.FAILED,
};

function team(row: {
  id: string;
  name: string;
  createdAt: Date;
  retiredAt: Date | null;
  retiredBy?: string | null;
  deletedAt?: Date | null;
  requireSso?: boolean;
  fromCatalog?: boolean;
  quota?: TeamQuota | null;
}) {
  const quota = effectiveQuota({ quota: row.quota ?? null });
  return {
    id: row.id,
    name: row.name,
    createdAt: timestamp(row.createdAt),
    retiredAt: timestamp(row.retiredAt),
    retiredBy: row.retiredBy ?? "",
    deletedAt: timestamp(row.deletedAt),
    requireSso: row.requireSso ?? false,
    fromCatalog: row.fromCatalog ?? false,
    quota,
    quotaIsDefault: (row.quota ?? null) === null,
    // The install's, on every team: the page compares the two without another call.
    installQuota: config.teamNamespaces.quota,
  };
}

export function teamService(): ServiceImpl<typeof TeamService> {
  return {
    async listTeams(_req, ctx) {
      return { teams: (await allTeams(callerOf(ctx))).map(team) };
    },

    async getTeam(req, ctx) {
      const { name } = check({ name: AnyTeam }, req);
      return { team: team(await teamRecord(callerOf(ctx), name)) };
    },

    async getTeamProfile(req, ctx) {
      const { name } = check({ name: AnyTeam }, req);
      return teamProfile(callerOf(ctx), name);
    },

    async listTeamSummaries(_req, ctx) {
      return { teams: await teamSummaries(callerOf(ctx)) };
    },

    async createTeam(req, ctx) {
      const { name } = check({ name: TeamName }, req);
      return { team: team(await newTeam(callerOf(ctx), name, logOf(ctx))) };
    },

    async ensureTeam(req, ctx) {
      const { name } = check({ name: TeamName }, req);
      const ensured = await ensureTeam(callerOf(ctx), name, logOf(ctx));
      return { team: team(ensured), created: ensured.created };
    },

    async retireTeam(req, ctx) {
      const { name } = check({ name: AnyTeam }, req);
      const retired = await retireTeam(callerOf(ctx), name, logOf(ctx));
      return { unregisteredProducts: retired.unregisteredProducts };
    },

    async unretireTeam(req, ctx) {
      const { name } = check({ name: AnyTeam }, req);
      await unretireTeam(callerOf(ctx), name, logOf(ctx));
      return {};
    },

    async purgeTeam(req, ctx) {
      const { name } = check({ name: AnyTeam }, req);
      const purged = await purgeTeam(callerOf(ctx), name, logOf(ctx));
      return {
        alreadyPurged: "alreadyPurged" in purged,
        revokedBotTokens: purged.revokedBotTokens,
        namespaceDeleted: purged.namespaceDeleted,
      };
    },

    async listMembers(req, ctx) {
      const { team: name } = check({ team: AnyTeam }, req);
      const rows = await members(callerOf(ctx), name);
      return {
        members: rows.map((member) => ({
          id: member.id,
          email: member.email,
          isBot: member.isBot,
          isAdmin: member.isAdmin,
          addedAt: timestamp(member.addedAt),
          role: toRole[member.role],
          hasPassword: member.hasPassword,
          usesSso: member.usesSso,
          followsGroups: member.followsGroups,
          viaGroups: member.followsGroups ? (member.viaGroups ?? []) : [],
        })),
      };
    },

    async addMember(req, ctx) {
      const caller = callerOf(ctx);
      await addMemberLimit.take(`members:${caller.id}`, ctx);
      const { team: name, email } = check({ team: AnyTeam, email: MemberEmail }, req);
      await addMember(caller, name, email, roleOf(req.role, "member"));
      return {};
    },

    async removeMember(req, ctx) {
      const { team: name, userId } = check({ team: AnyTeam, userId: MemberId }, req);
      await removeMember(callerOf(ctx), name, userId, logOf(ctx));
      return {};
    },

    async setMemberRole(req, ctx) {
      const { team: name, userId } = check({ team: AnyTeam, userId: MemberId }, req);
      await setMemberRole(callerOf(ctx), name, userId, roleOf(req.role), logOf(ctx));
      return {};
    },

    async setTeamQuota(req, ctx) {
      const { team: name } = check({ team: AnyTeam }, req);
      const q = req.quota;
      const quota = req.useDefault ? null : { cpu: q?.cpu ?? "", memory: q?.memory ?? "", pods: q?.pods ?? "", stepMemory: q?.stepMemory ?? "" };
      return { team: team(await setTeamQuota(callerOf(ctx), name, quota, logOf(ctx))) };
    },

    async setTeamSignIn(req, ctx) {
      const { team: name } = check({ team: AnyTeam }, req);
      await setTeamSignIn(callerOf(ctx), name, req.requireSso, logOf(ctx));
      return {};
    },

    async applySecretStore(req, ctx) {
      const input = check(
        { team: AnyTeam, documents: SecretStoreDocuments, credential: Type.Optional(SecretStoreCredential) },
        { team: req.team, documents: req.documents, credential: req.credential },
      );
      await applySecretStore(
        callerOf(ctx),
        input.team,
        { documents: input.documents, credential: input.credential },
        logOf(ctx),
      );
      return {};
    },

    async setSecretStoreCredential(req, ctx) {
      const input = check({ team: AnyTeam, credential: SecretStoreCredential }, { team: req.team, credential: req.credential });
      await setSecretStoreCredential(callerOf(ctx), input.team, input.credential, logOf(ctx));
      return {};
    },

    async listPods(req, ctx) {
      const { team: name } = check({ team: AnyTeam }, req);
      const pods = await teamPods(callerOf(ctx), name);
      return {
        pods: pods.map((pod) => ({
          podName: pod.podName,
          executionId: pod.executionId ?? undefined,
          taskId: pod.taskKey ?? undefined,
          attempt: pod.attempt ?? undefined,
          image: pod.image ?? undefined,
          serviceAccount: pod.serviceAccount ?? undefined,
          state: POD_STATE[pod.state] ?? TaskPodState.UNSPECIFIED,
          problem: pod.problem ?? undefined,
          restarts: pod.restarts,
          startedAt: timestamp(pod.startedAt),
          finishedAt: timestamp(pod.finishedAt),
          execution: pod.execution
            ? {
                name: pod.execution.name,
                taskNumber: pod.execution.taskNumber ?? undefined,
                taskCount: pod.execution.taskCount ?? undefined,
              }
            : undefined,
        })),
      };
    },
  };
}
