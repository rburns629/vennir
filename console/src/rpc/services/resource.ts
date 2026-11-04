// SPDX-License-Identifier: MIT
/** ResourceService (proto/vennir/console/v1/resource.proto): core/resources.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { decideDeleteRequest, deleteResources, deleteRunResources, listDeleteRequests, listResources, type ResourceRef } from "../../core/resources.js";
import type { ResourceService } from "../../gen/vennir/console/v1/resource_pb.js";
import { callerOf, logOf } from "../context.js";
import { timestamp, unsetIfEmpty } from "../convert.js";
import { check } from "../validate.js";
import { viaKernel } from "./execution.js";

const Uuid = Type.String({ format: "uuid" });

function ref(r: ResourceRef) {
  return { id: r.id, type: r.type, externalId: r.externalId, name: r.name ?? "", executionId: r.executionId, input: r.input };
}

export function resourceService(): ServiceImpl<typeof ResourceService> {
  return {
    async listResources(req, ctx) {
      const { query, executionId, ids } = check(
        { query: Type.String({ maxLength: 200 }), executionId: Type.Union([Type.Literal(""), Uuid]), ids: Type.Array(Uuid, { maxItems: 50 }) },
        { query: req.query, executionId: req.executionId, ids: req.ids },
      );
      const found = await listResources(callerOf(ctx), {
        executionId: unsetIfEmpty(executionId),
        team: unsetIfEmpty(req.team),
        query,
        includeDeleted: req.includeDeleted,
        ids,
      });
      return {
        resources: found.map((r) => ({
          id: r.id,
          type: r.type,
          externalId: r.externalId,
          name: r.name ?? "",
          link: r.link ?? "",
          product: r.product,
          productTeam: r.productTeam,
          ownerTeam: r.ownerTeam ?? "",
          ownerEmail: r.ownerEmail ?? "",
          executionId: r.executionId,
          taskId: r.taskId,
          firstReportedAt: timestamp(r.firstReportedAt),
          reportedAt: timestamp(r.reportedAt),
          state: r.state,
          deletingExecutionId: r.deletingExecutionId ?? "",
          deletedAt: timestamp(r.deletedAt),
          canDelete: r.canDelete,
          provides: r.provides,
          dependsOn: r.dependsOn.map(ref),
          dependents: r.dependents.map(ref),
          hiddenDependents: r.hiddenDependents,
        })),
      };
    },

    async deleteResources(req, ctx) {
      const { resourceIds } = check({ resourceIds: Type.Array(Uuid, { minItems: 1, maxItems: 50 }) }, { resourceIds: req.resourceIds });
      return viaKernel(ctx, () => deleteResources(callerOf(ctx), resourceIds, logOf(ctx)));
    },

    async deleteRunResources(req, ctx) {
      const { executionId } = check({ executionId: Uuid }, req);
      return viaKernel(ctx, () => deleteRunResources(callerOf(ctx), executionId, logOf(ctx)));
    },

    async listDeleteRequests(_req, ctx) {
      const requests = await listDeleteRequests(callerOf(ctx));
      return {
        requests: requests.map((r) => ({
          id: r.id,
          resources: r.resources.map(ref),
          dependents: r.dependents.map(ref),
          ownerTeam: r.ownerTeam ?? "",
          requestedBy: r.requestedBy ?? "",
          createdAt: timestamp(r.createdAt),
          decision: r.decision ?? "",
          decidedBy: r.decidedBy ?? "",
          decidedAt: timestamp(r.decidedAt),
          executionId: r.executionId ?? "",
        })),
      };
    },

    async decideDeleteRequest(req, ctx) {
      const { id } = check({ id: Uuid }, { id: req.id });
      const { executionId } = await viaKernel(ctx, () => decideDeleteRequest(callerOf(ctx), id, req.approve, logOf(ctx)));
      return { executionId: executionId ?? "" };
    },
  };
}
