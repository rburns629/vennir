// SPDX-License-Identifier: MIT
/**
 * The console's Prometheus metrics, served on their own port (config
 * metricsPort) so the public listener never exposes them: Connect calls by
 * method and code (sign-in failures included), catalog syncs, image scans,
 * and Node's own process metrics. Labels are never a user, team or token.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { Interceptor } from "@connectrpc/connect";
import { ConnectError, Code } from "@connectrpc/connect";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "console_" });

export const rpcRequests = new Counter({
  name: "console_rpc_requests_total",
  help: "Connect calls answered, by procedure and code (ok, unauthenticated, permission_denied, internal...).",
  labelNames: ["procedure", "code"] as const,
  registers: [registry],
});

export const rpcDuration = new Histogram({
  name: "console_rpc_request_duration_seconds",
  help: "How long Connect calls took, by procedure.",
  labelNames: ["procedure"] as const,
  registers: [registry],
});

export const catalogSyncs = new Counter({
  name: "console_catalog_syncs_total",
  help: "Catalog release checks, by outcome (unchanged, applied, applied_with_problems, failed).",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const scansFinished = new Counter({
  name: "console_image_scans_total",
  help: "Image scans finished, by verdict (passed, failed, error).",
  labelNames: ["status"] as const,
  registers: [registry],
});

/** snake_case, as Connect's wire codes are: permission_denied. */
const codeName = (code: Code) => Code[code].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

/** Sign-in, whose failures VennirSignInBurst counts. */
export const SIGN_IN = "vennir.console.v1.AuthService/Login";

// The series an alert measures with increase() exist at zero from the start
// (the charts' monitoring.yaml): a series born holding a burst has no lower
// sample before it, so the burst that made it would never count. Sign-in's,
// by every code it could answer with, and each catalog check's outcome.
for (const code of Object.values(Code)) {
  if (typeof code === "number") rpcRequests.inc({ procedure: SIGN_IN, code: codeName(code) }, 0);
}
rpcRequests.inc({ procedure: SIGN_IN, code: "ok" }, 0);
for (const outcome of ["unchanged", "applied", "applied_with_problems", "failed"]) catalogSyncs.inc({ outcome }, 0);

/** Outermost: counts every call once, whatever the inner interceptors did. */
export const countCalls: Interceptor = (next) => async (req) => {
  const procedure = `${req.service.typeName}/${req.method.name}`;
  const stop = rpcDuration.startTimer({ procedure });
  try {
    const res = await next(req);
    rpcRequests.inc({ procedure, code: "ok" });
    return res;
  } catch (error) {
    rpcRequests.inc({ procedure, code: codeName(ConnectError.from(error).code) });
    throw error;
  } finally {
    stop();
  }
};

/** GET /metrics; anything else is 404. */
export function serveMetrics(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET" || req.url !== "/metrics") {
    res.writeHead(404).end();
    return;
  }
  registry
    .metrics()
    .then((body) => res.writeHead(200, { "Content-Type": registry.contentType }).end(body))
    .catch(() => res.writeHead(500).end());
}

/** Serves /metrics on its own port (0: not at all). */
export function startMetricsServer(port: number): Server | null {
  if (!port) return null;
  return createServer(serveMetrics).listen(port, "0.0.0.0");
}
