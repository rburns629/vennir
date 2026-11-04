// SPDX-License-Identifier: MIT
/**
 * Errors the Connect services return. Each carries a Connect code (what a
 * client library acts on) and, as a Failure detail, the same stable code
 * the REST API used (TEAM_RETIRED, LAST_MEMBER, ...), so callers that
 * branched on those keep a precise reason.
 *
 * Anything thrown that isn't a ConnectError never reaches the caller as it
 * is: interceptors.ts's maskErrors logs it and answers `internal` with a
 * generic message, as the REST error handler does for a 5xx.
 */
import { Code, ConnectError } from "@connectrpc/connect";
import type { JsonObject } from "@bufbuild/protobuf";
import { FailureSchema, ProblemSchema } from "../gen/vennir/console/v1/common_pb.js";

export function rpcError(
  code: Code,
  stableCode: string,
  message: string,
  retryable = false,
  detail?: JsonObject,
): ConnectError {
  return new ConnectError(message, code, undefined, [
    { desc: FailureSchema, value: { code: stableCode, message, retryable, ...(detail ? { detail } : {}) } },
  ]);
}

export const unauthenticated = (message = "Missing or invalid token."): ConnectError =>
  rpcError(Code.Unauthenticated, "UNAUTHORIZED", message);

export const forbidden = (message: string, stableCode = "FORBIDDEN"): ConnectError =>
  rpcError(Code.PermissionDenied, stableCode, message);

export const notFound = (message: string, stableCode = "NOT_FOUND"): ConnectError =>
  rpcError(Code.NotFound, stableCode, message);

export interface ProblemInit {
  field: string;
  code: string;
  message: string;
}

/** Every problem with a request at once, as Problem details. */
export function invalidArgument(problems: ProblemInit[]): ConnectError {
  const message = problems.map((p) => (p.field ? `${p.field}: ${p.message}` : p.message)).join("; ");
  return new ConnectError(
    message,
    Code.InvalidArgument,
    undefined,
    problems.map(({ field, code, message: text }) => ({ desc: ProblemSchema, value: { field, code, message: text } })),
  );
}

/** One problem, the common case. */
export const badRequest = (message: string, field = "", stableCode = "BAD_REQUEST"): ConnectError =>
  invalidArgument([{ field, code: stableCode, message }]);

/** The HTTP status a call's outcome corresponds to: what the audit log records. */
export function httpStatusFor(code: Code | undefined): number {
  switch (code) {
    case undefined:
      return 200;
    case Code.InvalidArgument:
    case Code.FailedPrecondition:
    case Code.OutOfRange:
      return 400;
    case Code.Unauthenticated:
      return 401;
    case Code.PermissionDenied:
      return 403;
    case Code.NotFound:
      return 404;
    case Code.AlreadyExists:
    case Code.Aborted:
      return 409;
    case Code.ResourceExhausted:
      return 429;
    case Code.Canceled:
      return 499;
    case Code.Unimplemented:
      return 501;
    case Code.Unavailable:
      return 503;
    case Code.DeadlineExceeded:
      return 504;
    default:
      return 500;
  }
}
