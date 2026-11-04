// SPDX-License-Identifier: MIT
/** ProductService (proto/vennir/console/v1/product.proto): core/products.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import type { JsonObject } from "@bufbuild/protobuf";
import { Type } from "@sinclair/typebox";
import {
  checkProductNow,
  deleteProduct,
  imageRepositories,
  products,
  RegisterProductBody,
  registerProduct,
  releaseRepository,
  setWiringTypes,
  WiringTypesBody,
  wiringTypes,
} from "../../core/products.js";
import type { ProductWithReleases } from "../../db/queries.js";
import type { ProductService } from "../../gen/vennir/console/v1/product_pb.js";
import { timestamp } from "../convert.js";
import { readinessOf, type ReadinessView } from "../../readiness.js";
import { callerOf, logOf } from "../context.js";
import { check } from "../validate.js";
import { runsHere } from "../../core/clouds.js";

function product(row: Omit<ProductWithReleases, "teamName" | "releases"> & Partial<Pick<ProductWithReleases, "teamName" | "releases">>) {
  return {
    id: row.id,
    name: row.name,
    image: row.image,
    action: row.action,
    teamId: row.teamId ?? undefined,
    teamName: row.teamName ?? undefined,
    inputSchema: row.inputSchema as JsonObject,
    outputSchema: row.outputSchema as JsonObject,
    displayName: row.displayName ?? undefined,
    description: row.description ?? undefined,
    serviceAccount: row.serviceAccount ?? undefined,
    secretRefs: row.secretRefs,
    tokenAudiences: row.tokenAudiences,
    shareWith: row.shareWith,
    deprecated: row.deprecated ?? "",
    resources: row.resources ?? undefined,
    clouds: row.clouds,
    cloudsFrom: row.cloudsFrom,
    runsHere: runsHere(row.clouds),
    createdAt: timestamp(row.createdAt),
    releases: (row.releases ?? []).map((release) => ({
      image: release.image,
      registeredAt: timestamp(release.registeredAt),
    })),
  };
}

/** A product's readiness as the API gives it. */
export function readiness(view: ReadinessView | undefined) {
  return view
    ? {
        state: view.state,
        principal: view.principal ?? "",
        missing: view.missing,
        detail: view.detail ?? "",
        checkedAt: timestamp(view.checkedAt),
        executionId: view.executionId ?? "",
      }
    : undefined;
}

/** Only the fields a request set, as a REST body would carry them. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function productService(): ServiceImpl<typeof ProductService> {
  return {
    async listProducts(_req, ctx) {
      const all = await products(callerOf(ctx));
      const ready = await readinessOf(all);
      return { products: all.map((p) => ({ ...product(p), readiness: readiness(ready.get(p.name)) })) };
    },

    async checkProduct(req, ctx) {
      const { name } = check({ name: Type.String({ minLength: 1, maxLength: 253 }) }, req);
      return checkProductNow(callerOf(ctx), name, logOf(ctx));
    },

    async registerProduct(req, ctx) {
      const input = defined({
        name: req.name,
        image: req.image,
        action: req.action,
        team: req.team,
        inputSchema: req.inputSchema,
        outputSchema: req.outputSchema,
        displayName: req.displayName,
        description: req.description,
        serviceAccount: req.serviceAccount,
        // Always replaced: a registration is the whole product.yaml.
        secretRefs: req.secretRefs,
        tokenAudiences: req.tokenAudiences,
        shareWith: req.shareWith,
        deprecated: req.deprecated,
        resources: req.resources ? defined({ cpu: req.resources.cpu, memory: req.resources.memory, memoryLimit: req.resources.memoryLimit }) : undefined,
      });
      const { registration } = check({ registration: RegisterProductBody }, { registration: input });
      const registered = await registerProduct(callerOf(ctx), registration);
      return { product: product(registered) };
    },

    async deleteProduct(req, ctx) {
      const { name } = check({ name: Type.String({ minLength: 1 }) }, req);
      await deleteProduct(callerOf(ctx), name);
      return {};
    },

    async listImageRepositories(_req, ctx) {
      const rows = await imageRepositories(callerOf(ctx));
      return {
        repositories: rows.map((row) => ({
          repository: row.repository,
          teamName: row.teamName ?? undefined,
          createdAt: timestamp(row.createdAt),
          products: row.products,
        })),
      };
    },

    async releaseImageRepository(req, ctx) {
      const { repository } = check({ repository: Type.String({ minLength: 1 }) }, req);
      await releaseRepository(callerOf(ctx), repository);
      return {};
    },

    async listWiringTypes(_req, ctx) {
      callerOf(ctx);
      return { types: (await wiringTypes()).map(wiringType) };
    },

    async replaceWiringTypes(req, ctx) {
      const body = Object.fromEntries(
        Object.entries(req.types).map(([name, type]) => [
          name,
          defined({
            jsonType: type.jsonType,
            description: type.description,
            shared: type.shared,
            defaultProvider: type.defaultProvider,
          }),
        ]),
      );
      const { types } = check({ types: WiringTypesBody }, { types: body });
      return { types: (await setWiringTypes(callerOf(ctx), types)).map(wiringType) };
    },
  };
}

function wiringType(row: {
  name: string;
  jsonType: string;
  description: string;
  shared: boolean;
  defaultProvider: string | null;
  team: string | null;
  updatedAt: Date;
}) {
  return {
    name: row.name,
    jsonType: row.jsonType,
    description: row.description,
    shared: row.shared,
    defaultProvider: row.defaultProvider ?? undefined,
    updatedAt: timestamp(row.updatedAt),
    team: row.team ?? undefined,
  };
}
