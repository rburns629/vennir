// SPDX-License-Identifier: MIT
/** ScheduleService (proto/vennir/console/v1/schedule.proto): core/schedules.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import type { JsonObject } from "@bufbuild/protobuf";
import { Type } from "@sinclair/typebox";
import { createSchedule, deleteSchedule, listSchedules, updateSchedule, type ScheduleView } from "../../core/schedules.js";
import type { ScheduleService } from "../../gen/vennir/console/v1/schedule_pb.js";
import { callerOf } from "../context.js";
import { timestamp } from "../convert.js";
import { check } from "../validate.js";

const Uuid = Type.String({ format: "uuid" });
const Name = Type.String({ minLength: 1, maxLength: 253 });

function schedule(s: ScheduleView) {
  return {
    id: s.id,
    team: s.team,
    name: s.name,
    kind: s.kind,
    runnableTeam: s.runnableTeam,
    runnableName: s.runnableName,
    parameters: s.parameters as JsonObject,
    cron: s.cron,
    timeZone: s.timeZone,
    botId: s.botId,
    botEmail: s.botEmail,
    enabled: s.enabled,
    nextRunAt: timestamp(s.nextRunAt),
    lastRunAt: timestamp(s.lastRunAt),
    lastExecutionId: s.lastExecutionId ?? "",
    lastError: s.lastError ?? "",
  };
}

export function scheduleService(): ServiceImpl<typeof ScheduleService> {
  return {
    async listSchedules(req, ctx) {
      const { team } = check({ team: Name }, req);
      return { schedules: (await listSchedules(callerOf(ctx), team)).map(schedule) };
    },

    async createSchedule(req, ctx) {
      const input = check(
        {
          team: Name,
          name: Type.String({ minLength: 1, maxLength: 100 }),
          kind: Type.Union([Type.Literal("template"), Type.Literal("action")]),
          runnableTeam: Name,
          runnableName: Name,
          cron: Type.String({ minLength: 1, maxLength: 200 }),
          timeZone: Type.String({ maxLength: 64 }),
          botId: Uuid,
        },
        { team: req.team, name: req.name, kind: req.kind, runnableTeam: req.runnableTeam, runnableName: req.runnableName, cron: req.cron, timeZone: req.timeZone, botId: req.botId },
      );
      const made = await createSchedule(callerOf(ctx), input.team, {
        name: input.name,
        kind: input.kind,
        runnableTeam: input.runnableTeam,
        runnableName: input.runnableName,
        parameters: req.parameters ?? {},
        cron: input.cron,
        timeZone: input.timeZone || "UTC",
        botId: input.botId,
        enabled: true,
      });
      return { schedule: schedule(made) };
    },

    async updateSchedule(req, ctx) {
      const { id } = check({ id: Uuid }, { id: req.id });
      const change = check(
        {
          enabled: Type.Optional(Type.Boolean()),
          cron: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
          botId: Type.Optional(Uuid),
        },
        { enabled: req.enabled, cron: req.cron, timeZone: req.timeZone, botId: req.botId },
      );
      const updated = await updateSchedule(callerOf(ctx), id, { ...change, ...(req.parameters ? { parameters: req.parameters } : {}) });
      return { schedule: schedule(updated) };
    },

    async deleteSchedule(req, ctx) {
      const { id } = check({ id: Uuid }, req);
      await deleteSchedule(callerOf(ctx), id);
      return {};
    },
  };
}
