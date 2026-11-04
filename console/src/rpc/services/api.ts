// SPDX-License-Identifier: MIT
/** ApiService (proto/vennir/console/v1/api.proto): core/apis.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { getApi, getApiTraffic, getGateway, listApis, pauseApi, setGatewayClosed, type ApiView } from "../../core/apis.js";
import { timestamp } from "../convert.js";
import { ApiState, type ApiService } from "../../gen/vennir/console/v1/api_pb.js";
import { callerOf } from "../context.js";
import { check } from "../validate.js";

const Name = Type.String({ minLength: 1, maxLength: 63 });

const STATE = { live: ApiState.LIVE, held: ApiState.HELD, paused: ApiState.PAUSED, unavailable: ApiState.UNAVAILABLE } as const;

function product(a: ApiView) {
  return { ...a, state: STATE[a.state], problemFoundAt: a.problemFoundAt ? timestamp(a.problemFoundAt) : undefined };
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
  };
}
