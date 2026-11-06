// SPDX-License-Identifier: MIT
/** ChatService (proto/vennir/console/v1/chat.proto): src/chat/agent.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { ask, askStream, type Answer, type AskRequest as AskQuestion } from "../../chat/agent.js";
import { chatModel } from "../../chat/model.js";
import { listChatFeedback, rateAnswer } from "../../core/chatFeedback.js";
import { countQuestion, getChatLimits, setChatLimits, type ChatLimitsView } from "../../core/chatLimits.js";
import { getChatConfig, resetChatConfig, setChatConfig, testChatConfig, type ChatConfigInput, type ChatConfigView } from "../../core/chatSettings.js";
import { currentChat } from "../../chat/settings.js";
import type { AskRequest, AskStreamRequest, ChatConfigInput as ChatConfigMessage, ChatService } from "../../gen/vennir/console/v1/chat_pb.js";
import { callerOf, chatCallOf, logOf } from "../context.js";
import { timestamp } from "../convert.js";
import { FixedWindowLimit } from "../rateLimit.js";
import { check } from "../validate.js";

const Turn = Type.Object({ role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]), content: Type.String({ minLength: 1, maxLength: 4000 }) });

function limitsView(l: ChatLimitsView) {
  return { perHour: l.perHour, perDay: l.perDay, updatedBy: l.updatedBy, ...(l.updatedAt ? { updatedAt: timestamp(l.updatedAt) } : {}) };
}

/** Ask's request, checked. */
function asked(req: AskRequest | AskStreamRequest): AskQuestion {
  const { messages, team } = check(
    { messages: Type.Array(Turn, { minItems: 1, maxItems: 40 }), team: Type.String({ maxLength: 253 }) },
    { messages: req.messages.map((m) => ({ role: m.role, content: m.content })), team: req.team },
  );
  return { team: team || null, messages };
}

const Setting = (max: number) => Type.String({ maxLength: max });

/** Settings to save or try, checked at the edge (chatFrom checks what they mean). */
function configInput(c: ChatConfigMessage | undefined): ChatConfigInput {
  const valid = check(
    {
      provider: Setting(40),
      model: Setting(200),
      endpoint: Setting(500),
      vertexProject: Setting(40),
      vertexLocation: Setting(40),
      bedrockRegion: Setting(40),
      effort: Setting(10),
      apiKey: Setting(500),
      maxSteps: Type.Integer({ minimum: 0, maximum: 50 }),
      contextTokens: Type.Integer({ minimum: 0, maximum: 2_000_000 }),
      maxTokens: Type.Integer({ minimum: 0, maximum: 200_000 }),
    },
    {
      provider: c?.provider ?? "",
      model: c?.model ?? "",
      endpoint: c?.endpoint ?? "",
      vertexProject: c?.vertexProject ?? "",
      vertexLocation: c?.vertexLocation ?? "",
      bedrockRegion: c?.bedrockRegion ?? "",
      effort: c?.effort ?? "",
      apiKey: c?.apiKey ?? "",
      maxSteps: c?.maxSteps ?? 0,
      contextTokens: c?.contextTokens ?? 0,
      maxTokens: c?.maxTokens ?? 0,
    },
  );
  return {
    ...valid,
    enabled: c?.enabled ?? false,
    maxSteps: valid.maxSteps || null,
    contextTokens: valid.contextTokens || null,
    maxTokens: valid.maxTokens || null,
  };
}

function configView({ updatedAt, problem, ...v }: ChatConfigView) {
  return { config: { ...v, problem: problem ?? "", ...(updatedAt ? { updatedAt: timestamp(updatedAt) } : {}) } };
}

function response(answer: Answer) {
  return {
    text: answer.text,
    citations: answer.citations,
    uncited: answer.uncited,
    offTopic: answer.offTopic,
    contextPercent: answer.contextPercent,
    ...(answer.cart ? { cart: answer.cart } : {}),
    steps: answer.steps,
    model: answer.model,
  };
}


// A rating is kept 90 days, for admins to read: bounded per person.
const ratingLimit = new FixedWindowLimit(60, 60 * 60 * 1000, "ratings");

export function chatService(): ServiceImpl<typeof ChatService> {
  return {
    getChatSettings() {
      const chat = currentChat();
      return { enabled: chat !== null, model: chat?.model ?? "" };
    },

    async rateAnswer(req, ctx) {
      const valid = check(
        {
          rating: Type.Union([Type.Literal("up"), Type.Literal("down")]),
          team: Type.String({ maxLength: 253 }),
          question: Type.String({ minLength: 1, maxLength: 4000 }),
          answer: Type.String({ maxLength: 20000 }),
          model: Type.String({ maxLength: 200 }),
          comment: Type.String({ maxLength: 2000 }),
          steps: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 40 }),
          // What an answer cites is a Docs page (citations.ts's linkOf): the
          // ratings are the caller's word, and admins follow these links.
          citations: Type.Array(
            Type.Object({
              id: Type.String({ pattern: "^S[0-9]{1,4}$" }),
              title: Type.String({ maxLength: 300 }),
              heading: Type.String({ maxLength: 300 }),
              kind: Type.String({ maxLength: 40 }),
              link: Type.String({ pattern: "^/docs/[A-Za-z0-9_-]+(#[a-z0-9-]*)?$", maxLength: 400 }),
            }),
            { maxItems: 40 },
          ),
        },
        {
          rating: req.rating,
          team: req.team,
          question: req.question,
          answer: req.answer,
          model: req.model,
          comment: req.comment,
          steps: req.steps,
          citations: req.citations.map((c) => ({ id: c.id, title: c.title, heading: c.heading, kind: c.kind, link: c.link })),
        },
      );
      const caller = callerOf(ctx);
      await ratingLimit.take(`chat-ratings:${caller.id}`, ctx);
      return rateAnswer(caller, { ...valid, team: valid.team || null, comment: valid.comment || null });
    },

    async listChatFeedback(req, ctx) {
      const { rating } = check({ rating: Type.Union([Type.Literal(""), Type.Literal("up"), Type.Literal("down")]) }, { rating: req.rating });
      const ratings = await listChatFeedback(callerOf(ctx), { rating: rating || undefined });
      return {
        ratings: ratings.map((r) => ({
          id: r.id,
          rating: r.rating,
          team: r.team ?? "",
          question: r.question,
          answer: r.answer,
          citations: r.citations.map((c) => ({ ...c, guide: "" })),
          steps: r.steps,
          model: r.model,
          comment: r.comment ?? "",
          email: r.email ?? "",
          createdAt: timestamp(r.createdAt),
        })),
      };
    },

    async getChatConfig(_req, ctx) {
      return configView(await getChatConfig(callerOf(ctx)));
    },

    async setChatConfig(req, ctx) {
      return configView(await setChatConfig(callerOf(ctx), configInput(req.config), logOf(ctx)));
    },

    async resetChatConfig(_req, ctx) {
      return configView(await resetChatConfig(callerOf(ctx), logOf(ctx)));
    },

    async testChatConfig(req, ctx) {
      return testChatConfig(callerOf(ctx), configInput(req.config), logOf(ctx), chatCallOf(ctx));
    },

    async getChatLimits(_req, ctx) {
      return { limits: limitsView(await getChatLimits(callerOf(ctx))) };
    },

    async setChatLimits(req, ctx) {
      return { limits: limitsView(await setChatLimits(callerOf(ctx), { perHour: req.perHour, perDay: req.perDay }, logOf(ctx))) };
    },

    async ask(req, ctx) {
      const counted = () => countQuestion(callerOf(ctx), ctx);
      return response(await ask(callerOf(ctx), asked(req), logOf(ctx), chatModel(), { signal: ctx.signal, counted, via: chatCallOf(ctx) }));
    },

    async *askStream(req, ctx) {
      const counted = () => countQuestion(callerOf(ctx), ctx);
      for await (const event of askStream(callerOf(ctx), asked(req), logOf(ctx), chatModel(), ctx.signal, counted, chatCallOf(ctx))) {
        yield "step" in event ? { event: { case: "step" as const, value: event.step } } : { event: { case: "answer" as const, value: response(event.answer) } };
      }
    },
  };
}
