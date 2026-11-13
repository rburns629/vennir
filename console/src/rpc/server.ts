// SPDX-License-Identifier: MIT
/**
 * The console's Connect services (proto/vennir/console/v1/), under /api
 * like every other route: /api/vennir.console.v1.<Service>/<Method>,
 * answering the Connect protocol (JSON or binary, so plain curl works),
 * gRPC-Web, and gRPC where the server speaks HTTP/2.
 *
 * Before each call a hook resolves the bearer credential
 * (auth/plugin.ts's resolveCaller); interceptors.ts then refuses
 * protected methods without one, records changes, and keeps internal
 * errors' details from callers.
 */
import { createContextValues } from "@connectrpc/connect";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import type { FastifyInstance } from "fastify";
import { resolveCaller } from "../auth/plugin.js";
import { AdminService } from "../gen/vennir/console/v1/admin_pb.js";
import { ObserveService } from "../gen/vennir/console/v1/observe_pb.js";
import { ApiService } from "../gen/vennir/console/v1/api_pb.js";
import { AuthService } from "../gen/vennir/console/v1/auth_pb.js";
import { ExecutionService } from "../gen/vennir/console/v1/execution_pb.js";
import { ImageService } from "../gen/vennir/console/v1/image_pb.js";
import { ProductService } from "../gen/vennir/console/v1/product_pb.js";
import { SecretService } from "../gen/vennir/console/v1/secret_pb.js";
import { TeamService } from "../gen/vennir/console/v1/team_pb.js";
import { TemplateService } from "../gen/vennir/console/v1/template_pb.js";
import { GuideService } from "../gen/vennir/console/v1/guide_pb.js";
import { TokenService } from "../gen/vennir/console/v1/token_pb.js";
import { UserService } from "../gen/vennir/console/v1/user_pb.js";
import { ResourceService } from "../gen/vennir/console/v1/resource_pb.js";
import { NotificationService } from "../gen/vennir/console/v1/notification_pb.js";
import { ScheduleService } from "../gen/vennir/console/v1/schedule_pb.js";
import { DraftService } from "../gen/vennir/console/v1/draft_pb.js";
import { ChatService } from "../gen/vennir/console/v1/chat_pb.js";
import { OrderService } from "../gen/vennir/console/v1/order_pb.js";
import { SsoService } from "../gen/vennir/console/v1/sso_pb.js";
import { kAuthError, kAuthProblem, kCaller, kClientIp, kLog, kRecheckCaller, kRequestId } from "./context.js";
import { audit, auditReads, maskErrors, requireCaller } from "./interceptors.js";
import { countCalls } from "../metrics.js";
import { adminService } from "./services/admin.js";
import { observeService } from "./services/observe.js";
import { apiService } from "./services/api.js";
import { authService } from "./services/auth.js";
import { executionService } from "./services/execution.js";
import { imageService } from "./services/image.js";
import { productService } from "./services/product.js";
import { secretService } from "./services/secret.js";
import { teamService } from "./services/team.js";
import { templateService } from "./services/template.js";
import { guideService } from "./services/guide.js";
import { tokenService } from "./services/token.js";
import { userService } from "./services/user.js";
import { resourceService } from "./services/resource.js";
import { notificationService } from "./services/notification.js";
import { scheduleService } from "./services/schedule.js";
import { draftService } from "./services/draft.js";
import { chatService } from "./services/chat.js";
import { orderService } from "./services/order.js";
import { ssoService } from "./services/sso.js";

/**
 * The most one request message may be. Connect reads a call's body before
 * any interceptor runs (so before requireCaller refuses someone not signed
 * in), and its own default is about 4 GiB; Fastify's bodyLimit doesn't
 * apply, as the Connect plugin reads bodies itself. 8 MiB holds the largest
 * thing a caller sends, a DAG of 500 steps with their inputs, many times
 * over; kernel-api takes 32 MiB from the console, which adds each step's
 * schemas. A larger one is answered resource_exhausted (429).
 */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

declare module "fastify" {
  interface FastifyRequest {
    /** Why a Connect call has no caller, when it has none. */
    authProblem?: string;
    /** Resolving the credential failed (not merely refused it). */
    authError?: Error;
  }
}

export async function registerRpc(app: FastifyInstance, api: FastifyInstance): Promise<void> {
  await api.register(async (rpc) => {
    rpc.addHook("preHandler", async (request) => {
      if (!request.headers.authorization) {
        request.authProblem = "Missing or invalid token.";
        return;
      }
      // Caught here only to be rethrown inside Connect (interceptors.ts),
      // so the caller gets a Connect error, masked like any other.
      try {
        const resolved = await resolveCaller(request);
        if (resolved.authUser) request.authUser = resolved.authUser;
        else request.authProblem = resolved.problem;
      } catch (error) {
        request.authError = error instanceof Error ? error : new Error(String(error));
      }
    });
    await rpc.register(fastifyConnectPlugin, {
      routes: (router) => {
        router.service(AuthService, authService(app));
        router.service(GuideService, guideService());
        router.service(UserService, userService());
        router.service(TokenService, tokenService());
        router.service(AdminService, adminService());
        router.service(ImageService, imageService());
        router.service(SecretService, secretService());
        router.service(ProductService, productService());
        router.service(TeamService, teamService());
        router.service(TemplateService, templateService());
        router.service(ApiService, apiService());
        router.service(ObserveService, observeService());
        router.service(ExecutionService, executionService());
        router.service(ResourceService, resourceService());
        router.service(NotificationService, notificationService());
        router.service(ScheduleService, scheduleService());
        router.service(DraftService, draftService());
        router.service(OrderService, orderService());
        router.service(ChatService, chatService());
        router.service(SsoService, ssoService());
      },
      // Outermost first.
      interceptors: [countCalls, maskErrors, audit, auditReads, requireCaller],
      readMaxBytes: MAX_REQUEST_BYTES,
      // Defaults spelled out (false, 0, [], ""), for callers reading the JSON.
      jsonOptions: { alwaysEmitImplicit: true },
      contextValues: (request) =>
        createContextValues()
          .set(kCaller, request.authUser)
          .set(kRecheckCaller, () => resolveCaller(request))
          .set(kAuthProblem, request.authProblem)
          .set(kAuthError, request.authError)
          .set(kClientIp, request.ip)
          .set(kRequestId, request.id)
          .set(kLog, request.log),
    });
  });
}
