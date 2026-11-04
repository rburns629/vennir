// SPDX-License-Identifier: MIT
/** Browser security headers on every response (index.ts registers helmet). */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

it("sends a CSP that only runs this origin's scripts and can't be framed", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/vennir.console.v1.AuthService/GetEnvironment",
    headers: { "content-type": "application/json" },
    payload: "{}",
  });
  const csp = String(response.headers["content-security-policy"]);
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  // A console served over plain HTTP must keep working.
  expect(csp).not.toContain("upgrade-insecure-requests");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
});

it("sends them on the app's own pages and on errors", async () => {
  // Any other GET is the single-page app's index.html: the page the CSP protects.
  const page = await app.inject({ method: "GET", url: "/executions" });
  expect(page.headers["content-security-policy"]).toBeDefined();
  const error = await app.inject({ method: "POST", url: "/api/no-such-route" });
  expect(error.statusCode).toBe(404);
  expect(error.headers["content-security-policy"]).toBeDefined();
});

it("answers an unknown /api path with a JSON 404, never the app's page", async () => {
  // GET /api/me was a REST route; the API is Connect now.
  const old = await app.inject({ method: "GET", url: "/api/me" });
  expect(old.statusCode).toBe(404);
  expect(old.headers["content-type"]).toContain("application/json");
});
