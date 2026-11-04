// SPDX-License-Identifier: MIT
/** DraftService (proto/vennir/console/v1/draft.proto): core/drafts.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import type { JsonObject } from "@bufbuild/protobuf";
import { Type } from "@sinclair/typebox";
import { deleteDraft, listDrafts, saveDraft, type DraftView } from "../../core/drafts.js";
import type { DraftService } from "../../gen/vennir/console/v1/draft_pb.js";
import { callerOf } from "../context.js";
import { timestamp } from "../convert.js";
import { check } from "../validate.js";

const Team = Type.String({ minLength: 1, maxLength: 253 });
// A template's name, and so its file's.
const DraftName = Type.String({ pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$" });

function draft(d: DraftView) {
  return {
    team: d.team,
    name: d.name,
    body: d.body as JsonObject,
    version: BigInt(d.version),
    updatedBy: d.updatedBy,
    updatedAt: timestamp(d.updatedAt),
  };
}

export function draftService(): ServiceImpl<typeof DraftService> {
  return {
    async listDrafts(req, ctx) {
      const { team } = check({ team: Type.String({ maxLength: 253 }) }, req);
      return { drafts: (await listDrafts(callerOf(ctx), team)).map(draft) };
    },

    async saveDraft(req, ctx) {
      const input = check(
        { team: Team, name: DraftName, version: Type.Integer({ minimum: 0 }) },
        { team: req.team, name: req.name, version: Number(req.version) },
      );
      return { draft: draft(await saveDraft(callerOf(ctx), { ...input, body: req.body ?? {} })) };
    },

    async deleteDraft(req, ctx) {
      const { team, name } = check({ team: Team, name: DraftName }, req);
      await deleteDraft(callerOf(ctx), team, name);
      return {};
    },
  };
}
