// SPDX-License-Identifier: MIT
/** UserService (proto/vennir/console/v1/user.proto): core/users.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { NewPassword } from "../../auth/password.js";
import { AccountTeams, createAccount, deleteAccount, Email, listAccounts, resetPassword, setAdmin } from "../../core/users.js";
import type { UserService } from "../../gen/vennir/console/v1/user_pb.js";
import { callerOf, logOf } from "../context.js";
import { check } from "../validate.js";

export function userService(): ServiceImpl<typeof UserService> {
  return {
    async listUsers(_req, ctx) {
      const users = await listAccounts(callerOf(ctx));
      return {
        users: users.map((user) => ({
          email: user.email,
          isAdmin: user.isAdmin,
          createdAt: timestampFromDate(user.createdAt),
          teamNames: user.teamNames,
          hasPassword: user.hasPassword,
          usesSso: user.usesSso,
          mustChangePassword: user.mustChangePassword,
          lastSignedInAt: user.lastSignedInAt ? timestampFromDate(user.lastSignedInAt) : undefined,
        })),
      };
    },

    async createUser(req, ctx) {
      const input = check({ email: Email, teams: AccountTeams, admin: Type.Boolean() }, req);
      return createAccount(callerOf(ctx), input, logOf(ctx));
    },

    async deleteUser(req, ctx) {
      const { email } = check({ email: Email }, req);
      await deleteAccount(callerOf(ctx), email, logOf(ctx));
      return {};
    },

    async setAdmin(req, ctx) {
      const { email } = check({ email: Email }, req);
      await setAdmin(callerOf(ctx), email, req.admin);
      return {};
    },

    async resetPassword(req, ctx) {
      const { email, newPassword } = check({ email: Email, newPassword: NewPassword }, req);
      await resetPassword(callerOf(ctx), email, newPassword, logOf(ctx));
      return {};
    },
  };
}
