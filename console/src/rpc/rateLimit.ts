// SPDX-License-Identifier: MIT
/**
 * Fixed-window limits for the Connect methods that check a password or are
 * otherwise worth bounding (sign-in, registration, password change, adding
 * members): fixed windows and keys per caller or address, since Connect's
 * routes can't carry @fastify/rate-limit settings.
 *
 * Counted in Postgres (rate_limit_windows), one row per key, so every copy
 * of the console counts the same attempts and a restart forgets nothing.
 * retention.ts deletes windows that have ended.
 */
import { Code, type HandlerContext } from "@connectrpc/connect";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { rpcError } from "./errors.js";

export class FixedWindowLimit {
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    /** What's counted, for the refusal: "attempts", "questions". */
    private readonly what = "attempts",
  ) {}

  /**
   * Counts an attempt for `key`; throws resource_exhausted, with a
   * Retry-After header, once more than `max` were made this window.
   */
  async take(key: string, ctx: HandlerContext, now = Date.now()): Promise<void> {
    const at = new Date(now);
    const resets = new Date(now + this.windowMs);
    // One statement: a window that has ended starts again at 1.
    const { rows } = await db.execute<{ count: number; resets_at: Date | string }>(sql`
      INSERT INTO rate_limit_windows (key, count, resets_at) VALUES (${key}, 1, ${resets})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN rate_limit_windows.resets_at <= ${at} THEN 1 ELSE rate_limit_windows.count + 1 END,
        resets_at = CASE WHEN rate_limit_windows.resets_at <= ${at} THEN ${resets} ELSE rate_limit_windows.resets_at END
      RETURNING count, resets_at`);
    const window = rows[0];
    if (!window || window.count <= this.max) return;
    const seconds = Math.max(1, Math.ceil((new Date(window.resets_at).getTime() - now) / 1000));
    ctx.responseHeader.set("Retry-After", String(seconds));
    throw rpcError(
      Code.ResourceExhausted,
      "RATE_LIMITED",
      `Too many ${this.what}. Try again in ${describe(seconds)}.`,
      true,
    );
  }
}

function describe(seconds: number): string {
  if (seconds < 120) return `${String(seconds)} seconds`;
  return `${String(Math.ceil(seconds / 60))} minutes`;
}
