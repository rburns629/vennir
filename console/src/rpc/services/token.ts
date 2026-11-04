// SPDX-License-Identifier: MIT
/** TokenService (proto/vennir/console/v1/token.proto): core/tokens.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  AutomationLabel,
  AutomationScopes,
  BotEmail,
  createAutomationToken,
  createBotToken,
  DEFAULT_TOKEN_DAYS,
  ExpiresInDays,
  listAutomationTokensFor,
  listBots,
  OrderTemplates,
  revokeToken,
  setBotCallback,
  setBotOrders,
  TokenId,
  TokenLabel,
} from "../../core/tokens.js";
import { addBotIdentity, createKeylessBot, listBotIdentities, removeBotIdentity } from "../../core/botIdentities.js";
import type { TokenService } from "../../gen/vennir/console/v1/token_pb.js";
import { callerOf, logOf } from "../context.js";
import { check } from "../validate.js";

const TeamName = Type.String({ minLength: 1 });
const optionalTime = (date: Date | null) => (date ? timestampFromDate(date) : undefined);

type IdentityRow = Awaited<ReturnType<typeof addBotIdentity>>;
const identity = (r: IdentityRow) => ({
  id: r.id,
  botId: r.botId,
  botEmail: r.botEmail,
  issuer: r.issuer,
  claims: r.claims,
  createdAt: timestampFromDate(r.createdAt),
  lastUsedAt: optionalTime(r.lastUsedAt),
});

export function tokenService(): ServiceImpl<typeof TokenService> {
  return {
    async listBotIdentities(req, ctx) {
      const { team } = check({ team: TeamName }, req);
      const found = await listBotIdentities(callerOf(ctx), team);
      return { identities: found.identities.map(identity), issuers: found.issuers, audience: found.audience };
    },

    async addBotIdentity(req, ctx) {
      const { team, botId, issuer } = check(
        { team: TeamName, botId: Type.String({ format: "uuid" }), issuer: Type.String({ minLength: 1, maxLength: 300 }) },
        { team: req.team, botId: req.botId, issuer: req.issuer },
      );
      return { identity: identity(await addBotIdentity(callerOf(ctx), team, botId, issuer, { ...req.claims })) };
    },

    async createKeylessBot(req, ctx) {
      const { team, email, orderTemplates, issuer } = check(
        { team: TeamName, email: BotEmail, orderTemplates: OrderTemplates, issuer: Type.String({ minLength: 1, maxLength: 300 }) },
        { team: req.team, email: req.email, orderTemplates: req.orderTemplates, issuer: req.issuer },
      );
      const made = await createKeylessBot(callerOf(ctx), team, { email, ordering: req.ordering, orderTemplates, issuer, claims: { ...req.claims } });
      return { email: made.email, identity: identity(made.identity) };
    },

    async removeBotIdentity(req, ctx) {
      const { id } = check({ id: Type.String({ format: "uuid" }) }, req);
      await removeBotIdentity(callerOf(ctx), id);
      return {};
    },

    async listBots(req, ctx) {
      const { team } = check({ team: TeamName }, req);
      const bots = await listBots(callerOf(ctx), team);
      return {
        bots: bots.map((bot) => ({
          id: bot.id,
          email: bot.email,
          tokens: bot.tokens.map((token) => ({
            id: token.id,
            label: token.label,
            createdAt: timestampFromDate(token.createdAt),
            lastUsedAt: optionalTime(token.lastUsedAt),
            expiresAt: optionalTime(token.expiresAt),
          })),
          ordering: bot.orderTemplates !== null,
          orderTemplates: bot.orderTemplates ?? [],
          callbackHost: bot.callback?.host ?? "",
          callbackLastSentAt: optionalTime(bot.callback?.lastSentAt ?? null),
          callbackLastError: bot.callback?.lastError ?? "",
        })),
      };
    },

    async createBotToken(req, ctx) {
      const { team, email, label, orderTemplates, expiresInDays } = check(
        { team: TeamName, email: BotEmail, label: TokenLabel, orderTemplates: OrderTemplates, expiresInDays: ExpiresInDays },
        { team: req.team, email: req.email, label: req.label, orderTemplates: req.orderTemplates, expiresInDays: req.expiresInDays ?? DEFAULT_TOKEN_DAYS },
      );
      return createBotToken(callerOf(ctx), team, { email, label, ordering: req.ordering, orderTemplates, expiresInDays });
    },

    async setBotOrders(req, ctx) {
      const { team, email, templates } = check({ team: TeamName, email: BotEmail, templates: OrderTemplates }, req);
      return setBotOrders(callerOf(ctx), team, email, templates);
    },

    async setBotCallback(req, ctx) {
      const { team, email } = check({ team: TeamName, email: BotEmail }, { team: req.team, email: req.email });
      return setBotCallback(callerOf(ctx), team, email, { url: req.url.trim(), rotateSecret: req.rotateSecret });
    },

    async revokeToken(req, ctx) {
      const { tokenId } = check({ tokenId: TokenId }, req);
      await revokeToken(callerOf(ctx), tokenId);
      return {};
    },

    async listAutomationTokens(_req, ctx) {
      const tokens = await listAutomationTokensFor(callerOf(ctx));
      return {
        tokens: tokens.map((token) => ({
          id: token.id,
          label: token.label,
          createdAt: timestampFromDate(token.createdAt),
          lastUsedAt: optionalTime(token.lastUsedAt),
          scopes: token.scopes,
          botEmail: token.botEmail,
          expiresAt: optionalTime(token.expiresAt),
        })),
      };
    },

    async createAutomationToken(req, ctx) {
      const input = check(
        { label: AutomationLabel, scopes: AutomationScopes, expiresInDays: ExpiresInDays },
        { label: req.label, scopes: req.scopes, expiresInDays: req.expiresInDays ?? DEFAULT_TOKEN_DAYS },
      );
      return createAutomationToken(callerOf(ctx), input, logOf(ctx));
    },
  };
}
