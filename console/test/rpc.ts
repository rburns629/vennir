// SPDX-License-Identifier: MIT
/**
 * Calling the console's Connect services in tests as plain JSON over HTTP,
 * the way curl would, through app.inject.
 */
import { randomUUID } from "node:crypto";
import { fromBinary } from "@bufbuild/protobuf";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { createUser, setUserAdmin } from "../src/db/queries.js";
import { users } from "../src/db/schema.js";
import { FailureSchema, ProblemSchema } from "../src/gen/vennir/console/v1/common_pb.js";

export const PASSWORD = "correct-horse-battery";

export interface RpcError {
  code: string;
  message: string;
  details?: { type: string; value: string }[];
}

export function rpcClient(app: () => FastifyInstance) {
  const createdEmails: string[] = [];

  async function rpc(
    service: string,
    method: string,
    body: object,
    options: { token?: string; ip?: string } = {},
  ) {
    return app().inject({
      method: "POST",
      url: `/api/vennir.console.v1.${service}/${method}`,
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      payload: JSON.stringify(body),
      remoteAddress: options.ip ?? "10.9.0.1",
    });
  }

  async function makeUser(options: { admin?: boolean } = {}): Promise<{ id: string; email: string }> {
    const email = `rpc-${randomUUID()}@example.com`;
    createdEmails.push(email);
    const user = await createUser(email, await hashPassword(PASSWORD));
    if (options.admin) await setUserAdmin(user.id, true);
    return { id: user.id, email };
  }

  async function signIn(email: string): Promise<string> {
    const ip = `10.8.${String(Math.floor(Math.random() * 250))}.${String(Math.floor(Math.random() * 250))}`;
    const response = await rpc("AuthService", "Login", { email, password: PASSWORD }, { ip });
    expect(response.statusCode).toBe(200);
    return response.json<{ token: string }>().token;
  }

  /** Accounts made here, and any a test made itself (`forget`), removed after. */
  async function cleanUp(also: string[] = []): Promise<void> {
    const emails = [...createdEmails, ...also];
    if (emails.length > 0) await db.delete(users).where(inArray(users.email, emails));
  }

  return { rpc, makeUser, signIn, cleanUp, createdEmails };
}

/** The Failure detail's stable code (FORBIDDEN, TEAM_RETIRED, ...). */
export function failureCode(error: RpcError): string | undefined {
  const detail = error.details?.find((d) => d.type === "vennir.console.v1.Failure");
  return detail ? fromBinary(FailureSchema, Buffer.from(detail.value, "base64")).code : undefined;
}

/** The Failure detail's extra information (allowed sources, findings, ...). */
export function failureDetail(error: RpcError): Record<string, unknown> | undefined {
  const detail = error.details?.find((d) => d.type === "vennir.console.v1.Failure");
  return detail ? fromBinary(FailureSchema, Buffer.from(detail.value, "base64")).detail : undefined;
}

/** Each Problem detail's message (a refused document's problems). */
export function problemMessages(error: RpcError): string[] {
  return (error.details ?? [])
    .filter((d) => d.type === "vennir.console.v1.Problem")
    .map((d) => fromBinary(ProblemSchema, Buffer.from(d.value, "base64")).message);
}

/** The fields an invalid_argument error names. */
export function problemFields(error: RpcError): string[] {
  return (error.details ?? [])
    .filter((d) => d.type === "vennir.console.v1.Problem")
    .map((d) => fromBinary(ProblemSchema, Buffer.from(d.value, "base64")).field);
}

/** A call's outcome: its Connect code ("ok" when it succeeded), the Failure
 * detail's stable code (TEAM_RETIRED, ...), its message, and its body. */
export interface Outcome<T> {
  code: string;
  failure: string | undefined;
  message: string | undefined;
  body: T;
}

/**
 * `call(token, "TeamService/RetireTeam", {name})`: one Connect call as
 * whoever holds token (none for a public method), as its outcome.
 */
export function caller(app: () => FastifyInstance) {
  return async function call<T = Record<string, unknown>>(
    token: string | undefined,
    procedure: string,
    body: object = {},
  ): Promise<Outcome<T>> {
    const response = await app().inject({
      method: "POST",
      url: `/api/vennir.console.v1.${procedure}`,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      payload: JSON.stringify(body),
      remoteAddress: "10.9.0.1",
    });
    if (response.statusCode === 200) {
      return { code: "ok", failure: undefined, message: undefined, body: response.json<T>() };
    }
    const error = response.json<RpcError>();
    return { code: error.code, failure: failureCode(error), message: error.message, body: error as unknown as T };
  };
}
