// SPDX-License-Identifier: MIT
/**
 * How many questions each person may ask the chat agent (decided
 * 2026-11-02, review D-5): every question can cost many model calls on a
 * billed model, so each person's are counted, an hour's and a day's, in
 * Postgres (rate_limit_windows), the same on every console. By default 30
 * an hour and 200 a day; admins set their own on the Admin page.
 */
import type { HandlerContext } from "@connectrpc/connect";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { ApiError, forbiddenUnlessAdmin } from "../apiError.js";
import type { AuthUser } from "../auth/plugin.js";
import { db } from "../db/client.js";
import { chatLimits, users } from "../db/schema.js";
import { FixedWindowLimit } from "../rpc/rateLimit.js";

export const DEFAULT_PER_HOUR = 30;
export const DEFAULT_PER_DAY = 200;
const MOST = 10_000;
const HOUR = 60 * 60 * 1000;

export interface ChatLimitsView {
  perHour: number;
  perDay: number;
  updatedBy: string;
  updatedAt: Date | null;
}

async function current(): Promise<ChatLimitsView> {
  const [row] = await db
    .select({ limits: chatLimits, updatedBy: users.email })
    .from(chatLimits)
    .leftJoin(users, eq(users.id, chatLimits.updatedBy))
    .where(eq(chatLimits.id, 1));
  if (!row) return { perHour: DEFAULT_PER_HOUR, perDay: DEFAULT_PER_DAY, updatedBy: "", updatedAt: null };
  return { perHour: row.limits.perHour, perDay: row.limits.perDay, updatedBy: row.updatedBy ?? "", updatedAt: row.limits.updatedAt };
}

export async function getChatLimits(caller: AuthUser | undefined): Promise<ChatLimitsView> {
  forbiddenUnlessAdmin(caller, "Requires admin access.");
  return current();
}

export async function setChatLimits(
  caller: AuthUser | undefined,
  input: { perHour: number; perDay: number },
  log: FastifyBaseLogger,
): Promise<ChatLimitsView> {
  forbiddenUnlessAdmin(caller, "Requires admin access.");
  const { perHour, perDay } = input;
  if (![perHour, perDay].every((n) => Number.isInteger(n) && n >= 1 && n <= MOST)) {
    throw new ApiError(400, "BAD_CHAT_LIMITS", `Each limit is 1 to ${MOST.toLocaleString("en-US")}.`);
  }
  if (perHour > perDay) throw new ApiError(400, "BAD_CHAT_LIMITS", "No more questions an hour than a day.");
  const values = { perHour, perDay, updatedBy: caller?.id ?? null, updatedAt: new Date() };
  await db.insert(chatLimits).values({ id: 1, ...values }).onConflictDoUpdate({ target: chatLimits.id, set: values });
  log.warn({ event: "chat_limits_changed", by: caller?.id, perHour, perDay }, "the chat agent's question limits changed");
  return current();
}

/** Counts a question of the caller's; refuses (RATE_LIMITED, with Retry-After) one over either limit. */
export async function countQuestion(caller: AuthUser | undefined, ctx: HandlerContext): Promise<void> {
  if (!caller) return; // refused as unauthenticated by the agent
  const { perHour, perDay } = await current();
  await new FixedWindowLimit(perHour, HOUR, "questions").take(`chat-hour:${caller.id}`, ctx);
  await new FixedWindowLimit(perDay, 24 * HOUR, "questions").take(`chat-day:${caller.id}`, ctx);
}
