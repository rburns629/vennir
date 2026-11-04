// SPDX-License-Identifier: MIT
/** NotificationService (proto/vennir/console/v1/notification.proto): core/notifications.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import {
  deleteTeamWebhook,
  emailPreferences,
  getAdminChannel,
  getTeamCallback,
  getTeamWebhook,
  setAdminChannel,
  setTeamCallback,
  setEmailPreferences,
  listNotifications,
  markNotificationsRead,
  setTeamWebhook,
  testTeamWebhook,
} from "../../core/notifications.js";
import type { NotificationService } from "../../gen/vennir/console/v1/notification_pb.js";
import { callerOf } from "../context.js";
import { timestamp } from "../convert.js";
import { check } from "../validate.js";

const Team = Type.String({ minLength: 1, maxLength: 63 });

type WebhookView = Awaited<ReturnType<typeof getTeamWebhook>>["webhook"];
const webhook = (w: WebhookView) => ({ ...w, lastSentAt: timestamp(w.lastSentAt), updatedAt: timestamp(w.updatedAt) });
type CallbackView = Awaited<ReturnType<typeof getTeamCallback>>["callback"];
const callback = (c: CallbackView) => ({ ...c, lastSentAt: timestamp(c.lastSentAt), updatedAt: timestamp(c.updatedAt) });

export function notificationService(): ServiceImpl<typeof NotificationService> {
  return {
    async listNotifications(req, ctx) {
      const { notifications, unreadCount } = await listNotifications(callerOf(ctx), req.unreadOnly);
      return {
        notifications: notifications.map((n) => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          body: n.body,
          link: n.link ?? "",
          createdAt: timestamp(n.createdAt),
          read: n.read,
        })),
        unreadCount,
      };
    },

    async markNotificationsRead(req, ctx) {
      const { ids } = check({ ids: Type.Array(Type.String({ format: "uuid" }), { maxItems: 200 }) }, { ids: req.ids });
      await markNotificationsRead(callerOf(ctx), ids, req.all);
      return {};
    },

    async getTeamWebhook(req, ctx) {
      const { team } = check({ team: Team }, req);
      const found = await getTeamWebhook(callerOf(ctx), team);
      return { webhook: webhook(found.webhook), allowedHosts: found.allowedHosts, adminChannel: found.adminChannel };
    },

    async setTeamWebhook(req, ctx) {
      const { team, url, kinds } = check(
        { team: Team, url: Type.String({ maxLength: 2048 }), kinds: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 10 }) },
        { team: req.team, url: req.url, kinds: req.kinds },
      );
      return { webhook: webhook((await setTeamWebhook(callerOf(ctx), team, url, kinds)).webhook) };
    },

    async deleteTeamWebhook(req, ctx) {
      const { team } = check({ team: Team }, req);
      await deleteTeamWebhook(callerOf(ctx), team);
      return {};
    },

    async getAdminChannel(_req, ctx) {
      return getAdminChannel(callerOf(ctx));
    },

    async setAdminChannel(req, ctx) {
      const { team } = check({ team: Type.String({ maxLength: 63 }) }, req);
      return setAdminChannel(callerOf(ctx), team);
    },

    async getEmailPreferences(_req, ctx) {
      return emailPreferences(callerOf(ctx));
    },

    async setEmailPreferences(req, ctx) {
      const { kinds } = check({ kinds: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 10 }) }, { kinds: req.kinds });
      return setEmailPreferences(callerOf(ctx), kinds);
    },

    async testTeamWebhook(req, ctx) {
      const { team } = check({ team: Team }, req);
      return testTeamWebhook(callerOf(ctx), team);
    },

    async getTeamCallback(req, ctx) {
      const { team } = check({ team: Team }, req);
      const found = await getTeamCallback(callerOf(ctx), team);
      return { callback: callback(found.callback), allowedHosts: found.allowedHosts };
    },

    async setTeamCallback(req, ctx) {
      const { team } = check({ team: Team }, { team: req.team });
      const result = await setTeamCallback(callerOf(ctx), team, req.url.trim(), req.rotateSecret);
      return { callback: callback(result.callback), signingSecret: result.signingSecret };
    },
  };
}
