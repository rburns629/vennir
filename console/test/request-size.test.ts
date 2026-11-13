// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { MAX_REQUEST_BYTES } from "../src/rpc/server.js";

let app: FastifyInstance;

function login(body: string) {
  return app.inject({
    method: "POST",
    url: "/api/vennir.console.v1.AuthService/Login",
    headers: { "content-type": "application/json" },
    payload: body,
    remoteAddress: "10.7.7.7",
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("request size", () => {
  it("refuses a request larger than the limit, before it's read as a call", async () => {
    const response = await login(JSON.stringify({ email: "a@example.com", password: "x".repeat(MAX_REQUEST_BYTES) }));
    expect(response.statusCode).toBe(429);
    expect(response.json<{ code: string }>().code).toBe("resource_exhausted");
  });

  it("still reads one under the limit", async () => {
    const response = await login(JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }));
    expect(response.statusCode).toBe(401);
  });

  it("refuses an email or a password longer than any real one", async () => {
    const longEmail = await login(JSON.stringify({ email: `${"a".repeat(320)}@example.com`, password: "wrong-password" }));
    expect(longEmail.statusCode).toBe(400);
    const longPassword = await login(JSON.stringify({ email: "nobody@example.com", password: "x".repeat(1025) }));
    expect(longPassword.statusCode).toBe(400);
  });
});
