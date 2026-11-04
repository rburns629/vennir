// SPDX-License-Identifier: MIT
/** SsoService (proto/vennir/console/v1/sso.proto): core/sso.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { deleteSsoGroupMapping, getSsoSettings, listSsoGroupMappings, setSsoGroupMapping, setSsoSettings, type SsoGroupMappingView, type SsoSettingsView } from "../../core/sso.js";
import type { SsoService } from "../../gen/vennir/console/v1/sso_pb.js";
import { TeamRole } from "../../gen/vennir/console/v1/team_pb.js";
import { callerOf, logOf } from "../context.js";
import { timestamp } from "../convert.js";
import { check } from "../validate.js";

function settings(s: SsoSettingsView) {
  return { ...s, updatedAt: timestamp(s.updatedAt) };
}

function mapping(m: SsoGroupMappingView) {
  return { ...m, role: m.role === "maintainer" ? TeamRole.MAINTAINER : TeamRole.MEMBER };
}

export function ssoService(): ServiceImpl<typeof SsoService> {
  return {
    async getSsoSettings(_req, ctx) {
      return { settings: settings(await getSsoSettings(callerOf(ctx))) };
    },

    async setSsoSettings(req, ctx) {
      const input = check(
        {
          issuer: Type.String({ maxLength: 500 }),
          clientId: Type.String({ maxLength: 500 }),
          clientSecret: Type.String({ maxLength: 2000 }),
          redirectUrl: Type.String({ maxLength: 500 }),
          allowedDomains: Type.Array(Type.String({ maxLength: 253 }), { maxItems: 50 }),
          label: Type.String({ maxLength: 100 }),
          groupsClaim: Type.String({ maxLength: 100 }),
        },
        req,
      );
      return { settings: settings(await setSsoSettings(callerOf(ctx), { ...input, enabled: req.enabled, googleGroups: req.googleGroups }, logOf(ctx))) };
    },

    async listSsoGroupMappings(_req, ctx) {
      return { mappings: (await listSsoGroupMappings(callerOf(ctx))).map(mapping) };
    },

    async setSsoGroupMapping(req, ctx) {
      const input = check({ group: Type.String({ minLength: 1, maxLength: 256 }), team: Type.String({ minLength: 1, maxLength: 253 }) }, req);
      const role = req.role === TeamRole.MAINTAINER ? "maintainer" : "member";
      return { mapping: mapping(await setSsoGroupMapping(callerOf(ctx), { ...input, role }, logOf(ctx))) };
    },

    async deleteSsoGroupMapping(req, ctx) {
      const { id } = check({ id: Type.String({ format: "uuid" }) }, req);
      await deleteSsoGroupMapping(callerOf(ctx), id, logOf(ctx));
      return {};
    },
  };
}
