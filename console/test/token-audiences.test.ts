// SPDX-License-Identifier: MIT
/**
 * A product's token audiences (src/tokenAudiences.ts): the ones that would
 * make a step's token good inside the cluster are refused at registration,
 * as are ones that can't be a file or a policy entry, and the rest are
 * stored and shown.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { products } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { tokenAudienceProblems, tokenFileName } from "../src/tokenAudiences.js";
import { caller, rpcClient } from "./rpc.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  updateIdentityPolicy: vi.fn(() => Promise.resolve(true)),
}));

/** A token file whose `aud` claim is audiences, as the kubelet writes one. */
function tokenFile(audiences: string[]): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const file = join(mkdtempSync(join(tmpdir(), "aud-")), "token");
  writeFileSync(file, `${part({ alg: "RS256" })}.${part({ aud: audiences, sub: "x" })}.signature`);
  return file;
}

const prefix = `aud-${randomUUID().slice(0, 6)}`;
let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
const kernelTokenFile = config.kernelApiTokenFile;

beforeAll(async () => {
  app = await buildApp();
  config.kernelApiTokenFile = tokenFile(["vennir-kernel-api"]);
});

afterAll(async () => {
  config.kernelApiTokenFile = kernelTokenFile;
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

describe("token audiences", () => {
  it("are files named after the audience", () => {
    expect(tokenFileName("sts.amazonaws.com")).toBe("sts.amazonaws.com");
    expect(tokenFileName("api://AzureADTokenExchange")).toBe("api___AzureADTokenExchange");
  });

  it("refuse the cluster's own audiences, and ones that can't be a file or a policy entry", () => {
    expect(tokenAudienceProblems(["sts.amazonaws.com", "api://AzureADTokenExchange"])).toEqual([]);
    for (const audiences of [
      ["https://kubernetes.default.svc.cluster.local"],
      ["vennir-kernel-api"],
      ["a,b"],
      ["with space"],
      [""],
      ["a:b", "a/b"],
      [".."],
      ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    ]) {
      expect(tokenAudienceProblems(audiences), JSON.stringify(audiences)).not.toEqual([]);
    }
  });

  it("are registered with a product, and refused there when they're the cluster's own", async () => {
    const admin = await users.makeUser({ admin: true });
    const token = await users.signIn(admin.email);
    const register = (name: string, tokenAudiences: string[]) =>
      call<{ product?: { tokenAudiences: string[] } }>(token, "ProductService/RegisterProduct", {
        name: `${prefix}-${name}`,
        image: `registry.example/platform/${prefix}-${name}:1`,
        action: "run",
        tokenAudiences,
      });

    const kept = await register("aws", ["sts.amazonaws.com"]);
    expect(kept.code).toBe("ok");
    expect(kept.body.product?.tokenAudiences).toEqual(["sts.amazonaws.com"]);

    const refused = await register("api", ["vennir-kernel-api"]);
    expect(refused.code).toBe("invalid_argument");
  });
});
