// SPDX-License-Identifier: MIT
/**
 * The console's Prometheus metrics: every Connect call counted by procedure
 * and code (a failed sign-in as unauthenticated), served on their own port
 * and nowhere on the console's.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { registry, serveMetrics, startMetricsServer } from "../src/metrics.js";
import { rpcClient } from "./rpc.js";

let app: FastifyInstance;
const { rpc } = rpcClient(() => app);

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function count(procedure: string, code: string): Promise<number> {
  const metric = await registry.getSingleMetric("console_rpc_requests_total")?.get();
  return metric?.values.find((v) => v.labels["procedure"] === procedure && v.labels["code"] === code)?.value ?? 0;
}

describe("metrics", () => {
  it("start what alerts measure at zero, so the burst that begins one counts", async () => {
    const text = await registry.metrics();
    for (const code of ["unauthenticated", "resource_exhausted", "invalid_argument"]) {
      expect(text).toMatch(new RegExp(`console_rpc_requests_total\\{procedure="vennir\\.console\\.v1\\.AuthService/Login",code="${code}"\\} \\d`));
    }
    expect(text).toContain('console_catalog_syncs_total{outcome="failed"} 0');
  });

  it("counts calls by procedure and code", async () => {
    const login = "vennir.console.v1.AuthService/Login";
    const before = await count(login, "unauthenticated");
    await rpc("AuthService", "Login", { email: `nobody-${randomUUID()}@example.com`, password: "x" });
    expect(await count(login, "unauthenticated")).toBe(before + 1);
  });

  it("serves /metrics on its own port, and not on the console's", async () => {
    const server = createServer(serveMetrics).listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      const body = await metrics.text();
      expect(body).toContain("console_rpc_requests_total");
      expect(body).toContain("console_process_cpu_seconds_total");
      expect((await fetch(`${base}/`)).status).toBe(404);
    } finally {
      server.close();
    }
    const spa = await app.inject({ method: "GET", url: "/metrics" });
    expect(spa.body).not.toContain("console_rpc_requests_total");
  });

  it("isn't served at all with port 0", () => {
    expect(startMetricsServer(0)).toBeNull();
  });
});
