// SPDX-License-Identifier: MIT
/**
 * The chat agent's model as admins set it (decision 24): the Admin page's
 * Chat agent section. What's in effect and whose it is; an admin's own
 * settings, checked as the install's are (config.ts chatFrom), saved, and
 * in effect on every replica within seconds (chat/settings.ts); back to
 * the install's; and a test of settings before they're saved, one real
 * question through the agent. A key is write-only: kept sealed, never sent
 * back. None on Vertex, which signs in as the console. Left out, the one
 * kept stays, or, for the install's own provider, the install's is used.
 * Admins only.
 */
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { ApiError, forbiddenUnlessAdmin } from "../apiError.js";
import type { AuthUser } from "../auth/plugin.js";
import { ask } from "../chat/agent.js";
import { ModelUnavailable, modelFor, type ChatModel } from "../chat/model.js";
import { chatSource, currentChat, installKeyFor, KEY_PURPOSE, keyless, refreshChatSettings, sameEndpoint } from "../chat/settings.js";
import { CHAT_PROVIDERS, chatFrom, config, type ChatConfig } from "../config.js";
import { db } from "../db/client.js";
import { chatSettings, users } from "../db/schema.js";
import { seal, unseal } from "../sealed.js";

const REQUIRES_ADMIN = "Requires admin access.";
const TEST_QUESTION = "How do I back up the databases?";

export interface ChatConfigInput {
  enabled: boolean;
  provider: string;
  model: string;
  endpoint: string;
  vertexProject: string;
  vertexLocation: string;
  bedrockRegion: string;
  effort: string;
  /** Null: the default. */
  maxSteps: number | null;
  contextTokens: number | null;
  maxTokens: number | null;
  /** Empty: keep the one kept (or the install's, for its provider). */
  apiKey: string;
}

export interface ChatConfigView {
  source: "install" | "admins";
  enabled: boolean;
  provider: string;
  model: string;
  endpoint: string;
  vertexProject: string;
  vertexLocation: string;
  bedrockRegion: string;
  effort: string;
  maxSteps: number;
  contextTokens: number;
  maxTokens: number;
  keySet: boolean;
  problem: string | null;
  updatedBy: string;
  updatedAt: Date | null;
  /** What Reset returns to: the install's provider and model, "" when it has none. */
  installProvider: string;
  installModel: string;
}

const bad = (message: string) => new ApiError(400, "BAD_CHAT_SETTINGS", message);

/** A kept key goes only where it was kept for: the same provider and endpoint. */
const keptFor = (input: Pick<ChatConfigInput, "provider" | "endpoint">, stored: typeof chatSettings.$inferSelect | undefined) =>
  stored?.apiKeyEncrypted && stored.provider === input.provider && sameEndpoint(stored.endpoint, input.endpoint) ? stored.apiKeyEncrypted : null;

/**
 * The key these settings use: the one given; else the one kept, for this
 * provider and endpoint; else the install's, for its own provider and
 * endpoint. A key is never sent to an address other than the one it was
 * given for.
 */
function keyFor(input: Pick<ChatConfigInput, "provider" | "apiKey" | "endpoint">, stored: typeof chatSettings.$inferSelect | undefined): string {
  if (keyless(input.provider)) return "";
  if (input.apiKey) return input.apiKey;
  const kept = keptFor(input, stored);
  if (kept) return unseal(kept, KEY_PURPOSE) ?? "";
  return installKeyFor(input.provider, input.endpoint);
}

/** The settings checked as the install's are: refused (400) naming what's wrong. */
function checked(input: ChatConfigInput, apiKey: string): ChatConfig {
  if (!(CHAT_PROVIDERS as readonly string[]).includes(input.provider)) throw bad(`A provider is one of ${CHAT_PROVIDERS.join(", ")}.`);
  let chat: ChatConfig | null;
  try {
    chat = chatFrom({ ...input, apiKey, timeoutSeconds: null });
  } catch (error) {
    throw bad(error instanceof Error ? error.message : String(error));
  }
  if (!chat) throw bad("Name a model.");
  // The console's own cloud identity goes only to its cloud's address.
  if (keyless(input.provider) && input.endpoint.trim()) {
    throw bad(`${input.provider === "vertex" ? "Vertex AI" : "Bedrock"}'s address is built from its ${input.provider === "vertex" ? "project and location" : "region"}: leave the endpoint empty.`);
  }
  return chat;
}

export async function getChatConfig(caller: AuthUser | undefined): Promise<ChatConfigView> {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  const [row] = await db
    .select({ settings: chatSettings, updatedBy: users.email })
    .from(chatSettings)
    .leftJoin(users, eq(users.id, chatSettings.updatedBy))
    .where(eq(chatSettings.id, 1));
  const { source, problem } = chatSource();
  const install = { installProvider: config.chat?.provider ?? "", installModel: config.chat?.model ?? "" };
  const s = row?.settings;
  if (!s) {
    const c = config.chat;
    return {
      source: "install",
      enabled: c !== null,
      provider: c?.provider ?? "",
      model: c?.model ?? "",
      // Vertex's and Bedrock's are built from their project or region: nothing to show.
      endpoint: c && keyless(c.provider) ? "" : (c?.endpoint ?? ""),
      vertexProject: c?.vertexProject ?? "",
      vertexLocation: c?.vertexLocation ?? "",
      bedrockRegion: c?.bedrockRegion ?? "",
      effort: c?.effort ?? "",
      maxSteps: c?.maxSteps ?? 0,
      contextTokens: c?.contextTokens ?? 0,
      maxTokens: c?.maxTokens ?? 0,
      keySet: Boolean(c?.apiKey),
      problem: null,
      updatedBy: "",
      updatedAt: null,
      ...install,
    };
  }
  // What's in effect, where it can be used; else as saved.
  const effective = source === "admins" ? currentChat() : null;
  return {
    source: "admins",
    enabled: s.enabled,
    provider: s.provider,
    model: effective?.model ?? s.model,
    endpoint: s.endpoint,
    vertexProject: s.vertexProject,
    vertexLocation: effective?.vertexLocation ?? s.vertexLocation,
    bedrockRegion: s.bedrockRegion,
    effort: s.effort,
    maxSteps: effective?.maxSteps ?? s.maxSteps ?? 0,
    contextTokens: effective?.contextTokens ?? s.contextTokens ?? 0,
    maxTokens: effective?.maxTokens ?? s.maxTokens ?? 0,
    keySet: Boolean(s.apiKeyEncrypted) || (!keyless(s.provider) && config.chat?.provider === s.provider && Boolean(config.chat.apiKey)),
    problem,
    updatedBy: row.updatedBy ?? "",
    updatedAt: s.updatedAt,
    ...install,
  };
}

export async function setChatConfig(caller: AuthUser | undefined, input: ChatConfigInput, log: FastifyBaseLogger): Promise<ChatConfigView> {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  const [stored] = await db.select().from(chatSettings).where(eq(chatSettings.id, 1));
  // Off needs nothing else; on is checked whole.
  if (input.enabled) checked(input, keyFor(input, stored));
  else if (!(CHAT_PROVIDERS as readonly string[]).includes(input.provider)) input = { ...input, provider: "openai-compatible" };
  // A key given is kept; one kept for another provider goes; Vertex and Bedrock keep none.
  const apiKeyEncrypted =
    keyless(input.provider) ? null : input.apiKey ? seal(input.apiKey, KEY_PURPOSE) : keptFor(input, stored);
  const values = {
    enabled: input.enabled,
    provider: input.provider,
    model: input.model.trim(),
    endpoint: input.endpoint.trim(),
    vertexProject: input.vertexProject.trim(),
    vertexLocation: input.vertexLocation.trim(),
    bedrockRegion: input.bedrockRegion.trim(),
    apiKeyEncrypted,
    effort: input.effort,
    maxSteps: input.maxSteps,
    contextTokens: input.contextTokens,
    maxTokens: input.maxTokens,
    updatedBy: caller?.id ?? null,
    updatedAt: new Date(),
  };
  await db.insert(chatSettings).values({ id: 1, ...values }).onConflictDoUpdate({ target: chatSettings.id, set: values });
  log.warn(
    { event: "chat_settings_changed", by: caller?.id, enabled: input.enabled, provider: input.provider, model: values.model, endpoint: values.endpoint.replace(/[?#].*$/, ""), keyChanged: Boolean(input.apiKey) },
    "the chat agent's settings changed",
  );
  await refreshChatSettings(log);
  return getChatConfig(caller);
}

/** Back to the install's settings: the admins' are forgotten, key and all. */
export async function resetChatConfig(caller: AuthUser | undefined, log: FastifyBaseLogger): Promise<ChatConfigView> {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  await db.delete(chatSettings).where(eq(chatSettings.id, 1));
  log.warn({ event: "chat_settings_changed", by: caller?.id, reset: true }, "the chat agent's settings are the install's again");
  await refreshChatSettings(log);
  return getChatConfig(caller);
}

export interface ChatTestResult {
  ok: boolean;
  /** What went wrong, without what another server answered. */
  problem: string;
  seconds: number;
  model: string;
  answer: string;
  citations: number;
}

/** Settings tried before they're saved: one real question through the agent, as the admin. */
export async function testChatConfig(caller: AuthUser | undefined, input: ChatConfigInput, log: FastifyBaseLogger): Promise<ChatTestResult> {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  const [stored] = await db.select().from(chatSettings).where(eq(chatSettings.id, 1));
  const settings = checked({ ...input, enabled: true }, keyFor(input, stored));
  const model = modelFor(settings);
  let failure: ModelUnavailable | null = null;
  const watched: ChatModel = {
    name: model.name,
    complete: (messages, tools, options) =>
      model.complete(messages, tools, options).catch((error: unknown) => {
        if (error instanceof ModelUnavailable) failure = error;
        throw error;
      }),
  };
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  try {
    const answer = await ask(caller, { team: null, messages: [{ role: "user", content: TEST_QUESTION }] }, log, watched);
    return { ok: true, problem: "", seconds: seconds(), model: answer.model, answer: answer.text.slice(0, 600), citations: answer.citations.length };
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "MODEL_UNAVAILABLE") throw error;
    const problem = (failure as ModelUnavailable | null)?.summary ?? "The model didn't answer.";
    return { ok: false, problem, seconds: seconds(), model: settings.model, answer: "", citations: 0 };
  }
}
