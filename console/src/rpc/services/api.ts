// SPDX-License-Identifier: MIT
/** ApiService (proto/vennir/console/v1/api.proto): core/apis.ts and core/apiAccess.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import {
  addGrant,
  decideRequest,
  listApiAccess,
  listAwayAccess,
  listMyAccess,
  listTeamBotAccess,
  MAX_GRANT_PER_MINUTE,
  MAX_GROUP,
  MAX_REASON,
  requestAccess,
  revokeGrant,
  setGrantRate,
  withdrawRequest,
  type GrantView,
  type RequestView,
  type Via,
} from "../../core/apiAccess.js";
import { getApi, getApiTraffic, getGateway, listApis, pauseApi, setGatewayClosed, type ApiView } from "../../core/apis.js";
import { timestamp } from "../convert.js";
import { ApiAccessRequestState, ApiAccessVia, ApiState, type ApiService } from "../../gen/vennir/console/v1/api_pb.js";
import { callerOf } from "../context.js";
import { check } from "../validate.js";

const Name = Type.String({ minLength: 1, maxLength: 63 });
const Id = Type.String({ format: "uuid" });
const PerMinute = Type.Integer({ minimum: 0, maximum: MAX_GRANT_PER_MINUTE });
const Reason = Type.String({ maxLength: MAX_REASON });
const Group = Type.String({ maxLength: MAX_GROUP });
const Email = Type.Union([Type.Literal(""), Type.String({ format: "email", maxLength: 320 })]);

const STATE = { live: ApiState.LIVE, held: ApiState.HELD, paused: ApiState.PAUSED, unavailable: ApiState.UNAVAILABLE } as const;
const VIA: Record<Via, ApiAccessVia> = { team: ApiAccessVia.TEAM, user: ApiAccessVia.USER, group: ApiAccessVia.GROUP, catalog: ApiAccessVia.CATALOG };
const REQUEST_STATE = {
  waiting: ApiAccessRequestState.WAITING,
  granted: ApiAccessRequestState.GRANTED,
  declined: ApiAccessRequestState.DECLINED,
  withdrawn: ApiAccessRequestState.WITHDRAWN,
} as const;

function product(a: ApiView) {
  return {
    ...a,
    state: STATE[a.state],
    accessVia: a.accessVia ? VIA[a.accessVia] : ApiAccessVia.UNSPECIFIED,
    problemFoundAt: a.problemFoundAt ? timestamp(a.problemFoundAt) : undefined,
  };
}

function grant(g: GrantView) {
  return { ...g, createdAt: timestamp(g.createdAt), updatedAt: timestamp(g.updatedAt), revokedAt: timestamp(g.revokedAt), awaySince: timestamp(g.awaySince) };
}

function request(r: RequestView) {
  return { ...r, state: REQUEST_STATE[r.state], createdAt: timestamp(r.createdAt), decidedAt: timestamp(r.decidedAt), groupsReadAt: timestamp(r.groupsReadAt), awaySince: timestamp(r.awaySince) };
}

export function apiService(): ServiceImpl<typeof ApiService> {
  return {
    async listApis(_req, ctx) {
      return { apis: (await listApis(callerOf(ctx))).map(product) };
    },

    async getApi(req, ctx) {
      const { team, name } = check({ team: Name, name: Name }, req);
      const { api, openapi } = await getApi(callerOf(ctx), team, name);
      return { api: product(api), openapi };
    },

    async pauseApi(req, ctx) {
      const { team, name, message } = check({ team: Name, name: Name, message: Type.String({ maxLength: 500 }) }, req);
      await pauseApi(callerOf(ctx), team, name, message);
      return {};
    },

    async resumeApi(req, ctx) {
      const { team, name } = check({ team: Name, name: Name }, req);
      await pauseApi(callerOf(ctx), team, name, null);
      return {};
    },

    async getApiTraffic(req, ctx) {
      const { team, name, hours } = check({ team: Name, name: Name, hours: Type.Integer({ minimum: 0, maximum: 168 }) }, req);
      const t = await getApiTraffic(callerOf(ctx), team, name, hours);
      return {
        requests: BigInt(t.requests),
        forwarded: BigInt(t.forwarded),
        stopped: BigInt(t.stopped),
        backendErrors: BigInt(t.backendErrors),
        endpoints: t.endpoints.map((e) => ({
          endpoint: e.endpoint,
          requests: BigInt(e.requests),
          invalid: BigInt(e.invalid),
          backend4xx: BigInt(e.backend4xx),
          backend5xx: BigInt(e.backend5xx),
          averageMs: BigInt(e.averageMs),
        })),
        blocked: t.blocked.map((b) => ({ request: b.request, count: BigInt(b.count), teams: b.teams, last: timestamp(b.last) })),
        teams: t.teams.map((x) => ({ team: x.team, requests: BigInt(x.requests), peakPerMinute: BigInt(x.peakPerMinute), limitPerMinute: x.limitPerMinute })),
      };
    },

    async getGateway(_req, ctx) {
      const g = await getGateway(callerOf(ctx));
      return {
        ...g,
        closedAt: timestamp(g.closedAt),
        requests24h: BigInt(g.requests24h),
        refused: g.refused.map((r) => ({ ...r, count: BigInt(r.count) })),
      };
    },

    async setGatewayClosed(req, ctx) {
      const { message } = check({ message: Type.String({ maxLength: 500 }) }, req);
      await setGatewayClosed(callerOf(ctx), message);
      return {};
    },

    async requestApiAccess(req, ctx) {
      const { team, name, reason, botEmail } = check({ team: Name, name: Name, reason: Reason, botEmail: Email }, req);
      const made = await requestAccess(callerOf(ctx), team, name, reason, botEmail);
      return { request: request(made.request), grant: made.grant ? grant(made.grant) : undefined };
    },

    async withdrawApiAccessRequest(req, ctx) {
      const { accessRequestId } = check({ accessRequestId: Id }, req);
      await withdrawRequest(callerOf(ctx), accessRequestId);
      return {};
    },

    async decideApiAccessRequest(req, ctx) {
      const { accessRequestId, approve, group, perMinute, reason } = check(
        { accessRequestId: Id, approve: Type.Boolean(), group: Group, perMinute: PerMinute, reason: Reason },
        req,
      );
      const decided = await decideRequest(callerOf(ctx), accessRequestId, approve, group, perMinute, reason);
      return { request: request(decided.request), grant: decided.grant ? grant(decided.grant) : undefined };
    },

    async addApiGrant(req, ctx) {
      const { team, name, group, email, perMinute } = check({ team: Name, name: Name, group: Group, email: Email, perMinute: PerMinute }, req);
      return { grant: grant(await addGrant(callerOf(ctx), team, name, group, email, perMinute)) };
    },

    async setApiGrantRate(req, ctx) {
      const { grantId, perMinute } = check({ grantId: Id, perMinute: PerMinute }, req);
      return { grant: grant(await setGrantRate(callerOf(ctx), grantId, perMinute)) };
    },

    async revokeApiGrant(req, ctx) {
      const { grantId, reason } = check({ grantId: Id, reason: Reason }, req);
      await revokeGrant(callerOf(ctx), grantId, reason);
      return {};
    },

    async listApiAccess(req, ctx) {
      const { team, name } = check({ team: Name, name: Name }, req);
      const a = await listApiAccess(callerOf(ctx), team, name);
      return { grants: a.grants.map(grant), requests: a.requests.map(request), shareWith: a.shareWith };
    },

    async listMyApiAccess(_req, ctx) {
      const mine = await listMyAccess(callerOf(ctx));
      return {
        access: mine.access.map((a) => ({
          team: a.team,
          name: a.name,
          via: VIA[a.via],
          callingTeam: a.callingTeam ?? "",
          group: a.group ?? "",
          grantId: a.grantId ?? "",
          perMinute: a.perMinute,
        })),
        requests: mine.requests.map(request),
      };
    },

    async listAwayApiAccess(req, ctx) {
      const { team } = check({ team: Name }, req);
      const a = await listAwayAccess(callerOf(ctx), team);
      return { grants: a.grants.map(grant), requests: a.requests.map(request) };
    },

    async listTeamBotApiAccess(req, ctx) {
      const { team } = check({ team: Name }, req);
      const a = await listTeamBotAccess(callerOf(ctx), team);
      return { grants: a.grants.map(grant), requests: a.requests.map(request) };
    },
  };
}
