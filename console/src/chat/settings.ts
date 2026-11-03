// SPDX-License-Identifier: MIT
/**
 * The chat agent's settings in effect (decision 24): an admin's, from the
 * Admin page (db's chatSettings), or else the install's (config.chat, the
 * chart's chat values). Everything that uses the model reads currentChat().
 * Read again every few seconds and after each change, so every console
 * replica follows a change within seconds. An admin's that can't be used
 * (a key that no longer unseals, a setting refused) turns chat off, logged,
 * and says why on the Admin page: never quietly the install's instead.
 */
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { chatFrom, config, type ChatConfig, type ChatInput } from "../config.js";
import { db } from "../db/client.js";
import { chatSettings } from "../db/schema.js";
import { unseal } from "../sealed.js";

export const KEY_PURPOSE = "chat api key";
const REFRESH_MS = 10_000;

type Row = typeof chatSettings.$inferSelect;
let current: { source: "install" } | { source: "admins"; chat: ChatConfig | null; problem: string | null } = { source: "install" };

/** The chat agent's settings in effect, or null when it's off. */
export function currentChat(): ChatConfig | null {
  return current.source === "admins" ? current.chat : config.chat;
}

/** Whose settings are in effect, and why an admin's can't be used, if they can't. */
export function chatSource(): { source: "install" | "admins"; problem: string | null } {
  return current.source === "admins" ? { source: "admins", problem: current.problem } : { source: "install", problem: null };
}

/** Providers that sign in as the console's own cloud identity: no key kept, no address chosen. */
export const keyless = (provider: string) => provider === "vertex" || provider === "bedrock";

/** Whether two base URLs are the same, a trailing slash aside. */
export const sameEndpoint = (a: string, b: string) => a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");

/** Whether the install's own key may go to this provider's endpoint: only to the install's own. */
export const installKeyFor = (provider: string, endpoint: string) =>
  !keyless(provider) && config.chat?.provider === provider && sameEndpoint(endpoint, config.chat.endpoint) ? config.chat.apiKey : "";

/** A saved row as settings to check, its key unsealed. */
export function inputOf(row: Row, apiKey: string): ChatInput {
  return {
    provider: row.provider,
    model: row.model,
    // Vertex's and Bedrock's address is built from the project or region,
    // whatever was saved: the console's own cloud identity goes nowhere else.
    endpoint: keyless(row.provider) ? "" : row.endpoint,
    apiKey,
    vertexProject: row.vertexProject,
    vertexLocation: row.vertexLocation,
    bedrockRegion: row.bedrockRegion,
    effort: row.effort,
    maxSteps: row.maxSteps,
    timeoutSeconds: null,
    maxTokens: row.maxTokens,
    contextTokens: row.contextTokens,
  };
}

export async function refreshChatSettings(log?: FastifyBaseLogger): Promise<void> {
  const [row] = await db.select().from(chatSettings).where(eq(chatSettings.id, 1));
  if (!row) {
    current = { source: "install" };
    return;
  }
  if (!row.enabled) {
    current = { source: "admins", chat: null, problem: null };
    return;
  }
  // None kept for the install's own provider: the install's (its Secret's).
  let apiKey = installKeyFor(row.provider, row.endpoint);
  if (row.apiKeyEncrypted) {
    const key = unseal(row.apiKeyEncrypted, KEY_PURPOSE);
    if (key === null) {
      log?.error({ event: "chat_key_unreadable" }, "the chat model's key can't be read (JWT_SECRET changed?): set it again on the Admin page");
      current = { source: "admins", chat: null, problem: "The saved key can't be read (the console's JWT secret changed?): set it again." };
      return;
    }
    apiKey = key;
  }
  try {
    current = { source: "admins", chat: chatFrom(inputOf(row, apiKey)), problem: null };
  } catch (error) {
    // Saved settings were checked when saved; a newer console may check more.
    const problem = error instanceof Error ? error.message : String(error);
    log?.error({ event: "chat_settings_refused", problem }, "an admin's chat settings can't be used");
    current = { source: "admins", chat: null, problem };
  }
}

export function startChatSettingsRefresh(log: FastifyBaseLogger): void {
  const timer = setInterval(() => {
    refreshChatSettings(log).catch((error: unknown) => {
      log.error({ event: "chat_settings_refresh_failed", err: error }, "couldn't read the chat agent's settings");
    });
  }, REFRESH_MS);
  timer.unref();
}
