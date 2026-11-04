// SPDX-License-Identifier: MIT
/**
 * The Connect services' shared machinery, through AuthService and
 * GuideService: called as plain JSON over HTTP, as curl would.
 *
 * - Credentials resolve the same either way round.
 * - Protected methods refuse a missing or bad credential.
 * - Input is checked against the account rules, every problem at once.
 * - The rate limits hold.
 * - An internal error's message never reaches the caller.
 * - Changes are audited, sign-in and passwords aren't.
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import * as queries from "../src/db/queries.js";
import { auditLog } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { failureCode, PASSWORD, problemFields, rpcClient, type RpcError } from "./rpc.js";

vi.mock("../src/db/queries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/queries.js")>();
  return { ...actual, findUserById: vi.fn(actual.findUserById) };
});

let app: FastifyInstance;
const { rpc, makeUser, signIn, cleanUp } = rpcClient(() => app);

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await cleanUp();
});

describe("credentials", () => {
  it("answers public methods without one", async () => {
    const response = await rpc("AuthService", "GetEnvironment", {});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("label");
  });

  it("refuses protected methods without one, or with a bad one", async () => {
    for (const token of [undefined, "not-a-token", "acx_not-a-real-api-token"]) {
      const response = await rpc("AuthService", "GetMe", {}, token ? { token } : {});
      expect(response.statusCode).toBe(401);
      const error = response.json<RpcError>();
      expect(error.code).toBe("unauthenticated");
      expect(failureCode(error)).toBe("UNAUTHORIZED");
    }
  });

  it("signs in, and the session works", async () => {
    const { id, email } = await makeUser();
    const token = await signIn(email);

    const me = await rpc("AuthService", "GetMe", {}, { token });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ userId: id, email, isAdmin: false });
  });

  it("refuses a wrong password the same way as an unknown email", async () => {
    const { email } = await makeUser();
    const wrong = await rpc("AuthService", "Login", { email, password: "not-the-password" });
    const unknown = await rpc("AuthService", "Login", { email: `nobody-${randomUUID()}@example.com`, password: "x" });
    for (const response of [wrong, unknown]) {
      expect(response.statusCode).toBe(401);
      expect(response.json<RpcError>().message).toBe("Invalid email or password.");
    }
  });
});

describe("input", () => {
  it("is checked against the account rules, every problem at once", async () => {
    const response = await rpc("AuthService", "Login", { email: "not-an-email", password: "" });
    expect(response.statusCode).toBe(400);
    const error = response.json<RpcError>();
    expect(error.code).toBe("invalid_argument");
    expect(problemFields(error).sort()).toEqual(["email", "password"]);
  });

  it("keeps a guide id from naming a path", async () => {
    const { email } = await makeUser();
    const token = await signIn(email);
    const response = await rpc("GuideService", "GetGuide", { id: "../../etc/passwd" }, { token });
    expect(response.json<RpcError>().code).toBe("invalid_argument");
  });
});

describe("guides", () => {
  it("lists them and returns one as markdown", async () => {
    const { email } = await makeUser();
    const token = await signIn(email);
    const list = await rpc("GuideService", "ListGuides", {}, { token });
    const guides = list.json<{ guides: { id: string; title: string }[] }>().guides;
    expect(guides.length).toBeGreaterThan(0);
    const first = guides[0];
    if (!first) throw new Error("no guides");

    const guide = await rpc("GuideService", "GetGuide", { id: first.id }, { token });
    expect(guide.json<{ markdown: string }>().markdown).toContain("#");

    const missing = await rpc("GuideService", "GetGuide", { id: "no-such-guide" }, { token });
    expect(missing.statusCode).toBe(404);
  });
});

describe("rate limits", () => {
  it("limits sign-in per client and email, with Retry-After", async () => {
    const email = `limited-${randomUUID()}@example.com`;
    const ip = "10.7.7.7";
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await rpc("AuthService", "Login", { email, password: "wrong" }, { ip });
      expect(response.statusCode).toBe(401);
    }
    const limited = await rpc("AuthService", "Login", { email, password: "wrong" }, { ip });
    expect(limited.statusCode).toBe(429);
    expect(limited.json<RpcError>().code).toBe("resource_exhausted");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);

    // Another client is still let through.
    const other = await rpc("AuthService", "Login", { email, password: "wrong" }, { ip: "10.7.7.8" });
    expect(other.statusCode).toBe(401);
  });
});

describe("password change", () => {
  it("needs the current password, then signs out other sessions and returns a fresh token", async () => {
    const { email } = await makeUser();
    const token = await signIn(email);
    // A second earlier: iat has one-second resolution.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const other = await signIn(email);

    const wrong = await rpc(
      "AuthService",
      "ChangePassword",
      { currentPassword: "not-it", newPassword: "a-brand-new-password" },
      { token: other },
    );
    expect(wrong.statusCode).toBe(400);
    expect(problemFields(wrong.json<RpcError>())).toEqual(["currentPassword"]);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const changed = await rpc(
      "AuthService",
      "ChangePassword",
      { currentPassword: PASSWORD, newPassword: "a-brand-new-password" },
      { token: other },
    );
    expect(changed.statusCode).toBe(200);
    const fresh = changed.json<{ token: string }>().token;

    expect((await rpc("AuthService", "GetMe", {}, { token })).statusCode).toBe(401);
    expect((await rpc("AuthService", "GetMe", {}, { token: fresh })).statusCode).toBe(200);
  });
});

describe("errors", () => {
  const actual = vi.importActual<typeof import("../src/db/queries.js")>("../src/db/queries.js");

  async function expectMasked(response: Awaited<ReturnType<typeof rpc>>) {
    expect(response.statusCode).toBe(500);
    const error = response.json<RpcError>();
    expect(error.code).toBe("internal");
    expect(error.message).toBe("Internal server error.");
    expect(JSON.stringify(error)).not.toContain("secret body");
  }

  it("never shows an internal error's message from a handler", async () => {
    const { email } = await makeUser();
    const token = await signIn(email);
    const { findUserById } = await actual;
    // The credential check reads the account first; the handler's own read fails.
    vi.mocked(queries.findUserById)
      .mockImplementationOnce(findUserById)
      .mockRejectedValueOnce(new Error("cluster said: secret body"));
    await expectMasked(await rpc("AuthService", "GetMe", {}, { token }));
  });

  it("fails the call, masked, when the credential can't be checked", async () => {
    const { email } = await makeUser();
    const token = await signIn(email);
    vi.mocked(queries.findUserById).mockRejectedValueOnce(new Error("cluster said: secret body"));
    await expectMasked(await rpc("AuthService", "GetMe", {}, { token }));
  });
});

describe("audit", () => {
  it("records a sign-in as the person it signed in", async () => {
    const { id, email } = await makeUser();
    await signIn(email);
    const rows = await db.select().from(auditLog).where(eq(auditLog.actorId, id)).orderBy(desc(auditLog.id));
    expect(rows.map((r) => [r.route, r.status])).toEqual([["vennir.console.v1.AuthService/Login", 200]]);
  });
});
