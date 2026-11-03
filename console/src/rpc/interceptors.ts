// SPDX-License-Identifier: MIT
/**
 * What every Connect call goes through, outermost first (rpc/server.ts):
 *
 * 1. maskErrors: an error that isn't a ConnectError (a database or
 *    Kubernetes failure, whose message can carry the cluster's response
 *    body) is logged in full and answered `internal` with a generic
 *    message, as the REST error handler does for a 5xx.
 * 2. audit: a method that can change something is recorded once answered,
 *    allowed or refused, with its request's identifying fields only
 *    (audit.ts), and the run it started, if any, and the client's
 *    address. Reads aren't; sign-ins are.
 * 3. requireCaller: every method but the few public ones needs a valid
 *    credential; one that couldn't be checked (the database failed) fails
 *    the call, whatever the method.
 */
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { toJson, type JsonObject } from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import { ApiError } from "../apiError.js";
import { targetFields, writeAuditEntry } from "../audit.js";
import { AuthService } from "../gen/vertra/console/v1/auth_pb.js";
import { ProblemSchema } from "../gen/vertra/console/v1/common_pb.js";
import { kAuthError, kAuthProblem, kCaller, kClientIp, kLog, kRequestId, kSignedIn } from "./context.js";
import { httpStatusFor, rpcError, unauthenticated } from "./errors.js";

const procedure = (service: { typeName: string }, method: { name: string }) => `${service.typeName}/${method.name}`;

/** Methods anyone may call, signed in or not. */
export const PUBLIC = new Set(
  [AuthService.method.getEnvironment, AuthService.method.register, AuthService.method.login, AuthService.method.exchangeToken].map((m) =>
    procedure(m.parent, m),
  ),
);

/** All a session may do while its password must be changed. */
// GetEnvironment is public anyway: the screen to change it shows the install.
const WHILE_CHANGING_PASSWORD = new Set(
  [AuthService.method.getMe, AuthService.method.changePassword, AuthService.method.getEnvironment, AuthService.method.signOut].map((m) =>
    procedure(m.parent, m),
  ),
);


const GENERIC = "Internal server error.";

export const maskErrors: Interceptor = (next) => async (req) => {
  const log = req.contextValues.get(kLog);
  const mask = (error: unknown): ConnectError => {
    if (error instanceof ConnectError) return error;
    // An expected refusal from the shared logic (apiError.ts), with any
    // problems it lists as Problem details: each a message, or a message
    // about a field ({field, message}: a template's parameters, say).
    if (error instanceof ApiError) {
      const { problems, ...rest } = error.extra;
      const detail = Object.keys(rest).length > 0 ? (JSON.parse(JSON.stringify(rest)) as JsonObject) : undefined;
      const retryAfter = typeof rest["retryAfterSeconds"] === "number" ? rest["retryAfterSeconds"] : undefined;
      const refusal = rpcError(error.connectCode, error.code, error.message, retryAfter !== undefined, detail);
      // A rate's refusal says when to come back, as the gateway's does.
      if (retryAfter !== undefined) refusal.metadata.set("Retry-After", String(retryAfter));
      if (Array.isArray(problems)) {
        for (const problem of problems as unknown[]) {
          const { field, message } =
            typeof problem === "object" && problem !== null
              ? (problem as { field?: unknown; message?: unknown })
              : { field: "", message: problem };
          refusal.details.push({
            desc: ProblemSchema,
            value: { field: typeof field === "string" ? field : "", code: error.code, message: String(message) },
          });
        }
      }
      return refusal;
    }
    log?.error({ err: error, procedure: procedure(req.service, req.method) }, "rpc failed");
    return new ConnectError(GENERIC, Code.Internal);
  };
  let res;
  try {
    res = await next(req);
  } catch (error) {
    throw mask(error);
  }
  if (!res.stream) return res;
  const messages = res.message;
  return {
    ...res,
    message: (async function* () {
      try {
        yield* messages;
      } catch (error) {
        throw mask(error);
      }
    })(),
  };
};

export const audit: Interceptor = (next) => async (req) => {
  const name = procedure(req.service, req.method);
  // Sign-ins, registering and password changes too, allowed or refused:
  // their requests carry secrets, but targetFields reads only the email.
  if (req.method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS) {
    return next(req);
  }
  // No one signed in, for a method that needs someone: requireCaller
  // refuses it before it does anything. Logged, never an audit entry, so
  // anyone who can reach the console can't fill the log (each entry waits
  // for the chain's lock).
  if (!PUBLIC.has(name) && !req.contextValues.get(kCaller)) {
    req.contextValues.get(kLog)?.info({ event: "rpc_unauthenticated", procedure: name, clientIp: req.contextValues.get(kClientIp) }, "a call with no one signed in was refused");
    return next(req);
  }
  let status = 200;
  // The run a call started, when it started one (a submit, a template, a
  // rerun): recorded so the entry reaches every team in that run.
  let started: string | undefined;
  try {
    const res = await next(req);
    if (!res.stream) {
      const executionId = (res.message as { executionId?: unknown }).executionId;
      if (typeof executionId === "string" && executionId) started = executionId;
    }
    return res;
  } catch (error) {
    // A refusal from the shared logic records the status REST would have.
    status = error instanceof ApiError ? error.statusCode : httpStatusFor(ConnectError.from(error).code);
    throw error;
  } finally {
    const log = req.contextValues.get(kLog);
    const target = req.stream ? {} : targetFields(toJson(req.method.input, req.message));
    if (started && target["executionId"] === undefined) target["executionId"] = started;
    const clientIp = req.contextValues.get(kClientIp);
    if (clientIp) target["clientIp"] = clientIp;
    if (log) {
      await writeAuditEntry(log, {
        actorId: req.contextValues.get(kCaller)?.id ?? req.contextValues.get(kSignedIn) ?? null,
        method: "RPC",
        route: name,
        target,
        status,
        requestId: req.contextValues.get(kRequestId),
      });
    }
  }
};

export const requireCaller: Interceptor = (next) => async (req) => {
  const authError = req.contextValues.get(kAuthError);
  if (authError !== undefined) throw authError;
  const name = procedure(req.service, req.method);
  const caller = req.contextValues.get(kCaller);
  if (!PUBLIC.has(name) && !caller) {
    throw unauthenticated(req.contextValues.get(kAuthProblem));
  }
  // A password someone else set: nothing but changing it until then.
  if (caller?.mustChangePassword && !WHILE_CHANGING_PASSWORD.has(name)) {
    throw rpcError(Code.PermissionDenied, "PASSWORD_CHANGE_REQUIRED", "Change your password first: an admin set this one.");
  }
  return next(req);
};
