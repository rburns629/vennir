// SPDX-License-Identifier: MIT
/**
 * What a Connect handler knows about its request, beyond the message:
 * set once per request in rpc/server.ts from what Fastify resolved.
 */
import { createContextKey, type HandlerContext } from "@connectrpc/connect";
import type { FastifyBaseLogger } from "fastify";
import type { AuthUser, CallerResolution } from "../auth/plugin.js";
import { unauthenticated } from "./errors.js";

/** The signed-in caller; unset when there's no valid credential. */
export const kCaller = createContextKey<AuthUser | undefined>(undefined, { description: "caller" });
/** Resolves the request's credential again, as it is now: for a stream
 * that outlives a change to who the caller is (WatchExecution). */
export const kRecheckCaller = createContextKey<(() => Promise<CallerResolution>) | undefined>(undefined, { description: "recheck caller" });
/** Why there's no caller, for the error a protected method answers with. */
export const kAuthProblem = createContextKey<string | undefined>(undefined, { description: "auth problem" });
/** An error resolving the credential (a database failure, say): the call
 * fails with it, masked, rather than going on as if nobody had signed in. */
export const kAuthError = createContextKey<Error | undefined>(undefined, { description: "auth error" });
/** The client's address, as Fastify resolved it (trustProxy). */
export const kClientIp = createContextKey<string>("", { description: "client ip" });
/** Who a sign-in call signed in, for its audit entry (it has no caller yet). */
export const kSignedIn = createContextKey<string | undefined>(undefined, { description: "signed in" });
export const kRequestId = createContextKey<string>("", { description: "request id" });
export const kLog = createContextKey<FastifyBaseLogger | undefined>(undefined, { description: "logger" });

/** The caller; every method but the public ones has one (interceptors.ts). */
export function callerOf(ctx: HandlerContext) {
  const caller = ctx.values.get(kCaller);
  if (!caller) throw unauthenticated(ctx.values.get(kAuthProblem));
  return caller;
}

/** The caller as they are now (their teams, a sign-out, a password reset):
 * refused when the credential no longer resolves to anyone. */
export async function currentCallerOf(ctx: HandlerContext): Promise<AuthUser> {
  const recheck = ctx.values.get(kRecheckCaller);
  if (!recheck) throw new Error("A Connect call without its request's credential check.");
  const resolved = await recheck();
  if (!resolved.authUser) throw unauthenticated(resolved.problem);
  return resolved.authUser;
}

/** The request's logger; rpc/server.ts always sets it. */
export function logOf(ctx: HandlerContext): FastifyBaseLogger {
  const log = ctx.values.get(kLog);
  if (!log) throw new Error("A Connect call without its request's logger.");
  return log;
}

/** The call, for what the chat agent's tools read on the caller's behalf (auditReads.ts). */
export function chatCallOf(ctx: HandlerContext): { route: string; clientIp: string; requestId: string } {
  return { route: `${ctx.service.typeName}/${ctx.method.name}`, clientIp: ctx.values.get(kClientIp), requestId: ctx.values.get(kRequestId) };
}
