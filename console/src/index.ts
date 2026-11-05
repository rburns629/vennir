// SPDX-License-Identifier: MIT
import path from "node:path";
import Fastify, { type FastifyError } from "fastify";
import { pathToFileURL } from "node:url";
import fastifyStatic from "@fastify/static";
import helmet from "@fastify/helmet";
import authPlugin from "./auth/plugin.js";
import { registerActivity } from "./activity.js";
import { startCatalogSync } from "./catalogSync.js";
import { startAuditExport } from "./auditExport.js";
import { startResourceRecorder } from "./resourceRecorder.js";
import { startNotifier } from "./notifier.js";
import { startReadiness } from "./readiness.js";
import { startScheduleRunner } from "./scheduleRunner.js";
import { reconcileScans } from "./scanning.js";
import { startPolicySync } from "./policySync.js";
import { pinRegisteredTags, syncIdentityPolicy } from "./productPolicy.js";
import { startRetention } from "./retention.js";
import { sql } from "drizzle-orm";
import { config } from "./config.js";
import { claimRegisteredImageRepositories, listAllSecretGrants } from "./db/queries.js";
import { deleteLegacySecretRole, writeFenceProblem } from "./k8s.js";
import { db } from "./db/client.js";
import { registerRpc } from "./rpc/server.js";
import { registerOidc } from "./auth/oidc.js";
import { refreshChatSettings, startChatSettingsRefresh } from "./chat/settings.js";
import { refreshSso, startGroupResync, startSsoRefresh } from "./sso.js";
import { startMetricsServer } from "./metrics.js";

// Built by ../frontend's own `npm run build`, copied to ../frontend/dist
// alongside this service's own compiled dist/ in the Docker image (see
// ../Dockerfile) -- one image, one process, one origin for both the API
// and the UI, so the browser never needs CORS to talk to either.
const FRONTEND_DIST = path.join(import.meta.dirname, "..", "frontend", "dist");

export async function buildApp() {
  const app = Fastify({
    logger: true,
    // By address only: none listed, and request.ip is the connection's.
    trustProxy: config.trustProxy.length > 0 ? config.trustProxy.join(",") : false,
  });

  // Fastify's default error handler puts any uncaught error's message (and
  // its .headers) in the response. @kubernetes/client-node's errors carry
  // the cluster's response body and headers, so those would reach the
  // caller. The API's own errors are Connect's (rpc/interceptors.ts masks
  // them the same way); this is for anything outside it: an error with a
  // 4xx statusCode is returned as it is, anything else is logged in full
  // and answered with a generic message.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) {
      reply.code(statusCode).send({ error: "BAD_REQUEST", message: error.message });
      return;
    }
    request.log.error(error);
    reply.code(500).send({ error: "INTERNAL_ERROR", message: "Internal server error." });
  });

  // Liveness never touches the database (a slow/down database shouldn't
  // get the process killed by an orchestrator's liveness probe); readiness
  // does, since a process that can't reach Postgres genuinely isn't ready
  // to serve traffic -- same split as kernel-api's (kernel/internal/api/server.go).
  app.get("/health/live", () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      reply.code(503).send({ status: "unavailable" });
      return;
    }
    reply.send({ status: "ok" });
  });

  // authPlugin only sets up JWT signing and verifying (request.jwtVerify,
  // app.jwt) -- it registers no routes of its own.
  await app.register(authPlugin);
  registerActivity(app);

  // Browser security headers on every response. The session token lives in
  // localStorage, so the Content-Security-Policy is what keeps an injected
  // script from running at all: scripts only from this origin. Styles allow
  // inline because MUI (emotion) injects them at runtime. Spelled out rather
  // than helmet's defaults, which add upgrade-insecure-requests: that breaks
  // a console served over plain HTTP (kind, or before TLS is set up).
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  // The API: Connect services (rpc/server.ts, from proto/), all under
  // /api, so none can share a URL with a page of the app: Fastify can't
  // tell a fetch() from a browser navigation, and an API route would win,
  // answering a page reload with JSON (or a 401).
  await app.register(
    async (api) => {
      await registerRpc(app, api);
      await registerOidc(api);
    },
    { prefix: "/api" },
  );

  await app.register(fastifyStatic, { root: FRONTEND_DIST });
  // Anything GET that isn't under /api or a real static asset is a
  // client-side route (e.g. /teams/gcp) -- React Router owns those, so
  // the SPA shell is what belongs there, not a 404. A non-GET request to
  // an unmatched path is almost certainly a bad API call, not
  // navigation, so that stays a real JSON 404.
  app.setNotFoundHandler((request, reply) => {
    // Under /api is never a page: an old REST path, say, gets a JSON 404,
    // not the app's HTML with a 200.
    if (request.method === "GET" && !request.url.startsWith("/api/")) {
      reply.sendFile("index.html", FRONTEND_DIST);
      return;
    }
    reply.code(404).send({ error: "NOT_FOUND", message: `No route: ${request.method} ${request.url}` });
  });

  return app;
}

async function main(): Promise<void> {
  const app = await buildApp();
  // Products registered before image repositories had owners get theirs.
  await claimRegisteredImageRepositories();
  // Products registered by tag before identities were tied to digests get
  // pinned (productPolicy.ts), then the identity policy written, so their
  // steps have their identity from the first request. A slow registry holds
  // up serving for PIN_WAIT_MS at most; past it, pinning finishes in the
  // background, and until then their steps run without it, as before.
  const pinning = pinRegisteredTags(app.log).then(
    async (pinned) => {
      if (pinned === 0) return;
      await syncIdentityPolicy().catch((error: unknown) => {
        app.log.error({ err: error, event: "identity_policy_sync_failed" }, "couldn't write the identity policy after pinning products");
      });
    },
    (error: unknown) => {
      app.log.error({ err: error, event: "product_pinning_failed" }, "couldn't pin the products registered by tag");
    },
  );
  const PIN_WAIT_MS = 30_000;
  let pinWait: ReturnType<typeof setTimeout> | undefined;
  const waited = await Promise.race([
    pinning.then(() => true),
    new Promise<false>((resolve) => {
      pinWait = setTimeout(() => {
        resolve(false);
      }, PIN_WAIT_MS);
    }),
  ]);
  clearTimeout(pinWait);
  if (!waited) app.log.warn({ event: "product_pinning_slow" }, "still pinning products registered by tag; serving meanwhile");
  // Single sign-on as admins set it (sso.ts): read before anyone signs in,
  // then every few seconds, so a change made on another console reaches this one.
  await refreshSso(app.log);
  startSsoRefresh(app.log);
  await refreshChatSettings(app.log);
  startChatSettingsRefresh(app.log);
  startGroupResync(app.log);
  // The cluster's copies of the console's lists (the identity and scan
  // policies): now, since things may have changed while no console ran, and
  // every few minutes after, so a failed write or a hand edit doesn't last.
  // A failure is logged and shown to admins (AdminService.GetPolicySync), not fatal:
  // the console still enforces the rules itself.
  startPolicySync(app.log, config.policySyncIntervalSeconds * 1000);
  startRetention(app.log);
  // The catalog's release (catalogSync.ts): now, then every few minutes.
  startCatalogSync(app.log);
  startAuditExport(app.log);
  // What finished runs made (resourceRecorder.ts): now, then every 30 seconds.
  startResourceRecorder(app.log);
  // Steps waiting for approval and the catalog, then chat webhooks (notifier.ts): every 30 seconds.
  startNotifier(app.log);
  // Products' readiness checks that are due (readiness.ts): now, then every five minutes.
  startReadiness(app.log);
  // Teams' schedules that are due (scheduleRunner.ts): now, then every 30 seconds.
  startScheduleRunner(app.log);
  // Image scans (scanning.ts): the cluster's list of admitted digests now,
  // then finished scans read, and due rescans started, every 15 seconds.
  // A failure is logged and tried again on the next round.
  if (config.scanning.enabled) {
    setInterval(() => {
      reconcileScans().catch((error: unknown) => {
        app.log.error({ err: error }, "could not reconcile image scans");
      });
    }, 15_000).unref();
  }
  // Secrets used to be granted to one ServiceAccount each, through a Role
  // per secret; now they're the team's. Removes those Roles from installs
  // that have them (nothing to do once they're gone, a few 404s).
  try {
    for (const { teamName, secretName } of await listAllSecretGrants()) {
      await deleteLegacySecretRole(teamName, secretName);
    }
  } catch (error) {
    app.log.error({ err: error }, "could not remove the per-secret Roles secrets no longer use");
  }
  // Without its write fence, the console's cluster-wide rights would reach
  // every namespace: it doesn't start (k8s.ts's writeFenceProblem).
  if (config.writeFencePolicy) {
    const problem = await writeFenceProblem(config.writeFencePolicy);
    if (problem) throw new Error(`The console's write fence isn't in force: ${problem}. Reinstall the console chart (writeFence).`);
    app.log.info({ event: "write_fence_checked", policy: config.writeFencePolicy }, "write fence in force");
  }
  await app.listen({ host: "0.0.0.0", port: config.port });
  startMetricsServer(config.metricsPort);
}

// Only start listening when run as the entry point (`node dist/index.js`,
// `tsx src/index.ts`) -- not when a test imports buildApp().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
