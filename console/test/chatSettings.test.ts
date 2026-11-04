// SPDX-License-Identifier: MIT
/**
 * The chat agent's model as admins set it (core/chatSettings.ts, chat/
 * settings.ts): admins only; checked as the install's are; the key kept
 * sealed and never sent back, kept for its provider and dropped with it;
 * in effect at once, and back to the install's on reset; an admin's that
 * can't be used turns chat off and says why; and a test of unsaved
 * settings that says whether the model answered, not what another server
 * said. Against a stand-in OpenAI-compatible server.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentChat, refreshChatSettings } from "../src/chat/settings.js";
import { chatFrom, config, type ChatConfig } from "../src/config.js";
import { db } from "../src/db/client.js";
import { auditLog, chatSettings } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller, rpcClient } from "./rpc.js";

let app: FastifyInstance;
let model: Server;
let endpoint = "";
/** What the stand-in answers: a model, or a broken backend that says too much. */
let broken = false;
const seenKeys: string[] = [];
const people = rpcClient(() => app);
const call = caller(() => app);
let admin = "";
let member = "";

type Config = { config?: Record<string, unknown> };
const input = (extra: Record<string, unknown> = {}) => ({ enabled: true, provider: "openai-compatible", model: "stand-in", endpoint, apiKey: "sk-first", ...extra });

beforeAll(async () => {
  model = createServer((req, res) => {
    seenKeys.push(req.headers.authorization ?? "");
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (broken) {
        res.writeHead(500).end("internal: db password is hunter2");
        return;
      }
      const sent = JSON.parse(body) as { tools?: unknown[]; tool_choice?: string; max_tokens?: number };
      // The scope check has no tools; the answer, the docs' silence.
      const content = sent.tools ? "The docs don't cover that." : "VENNIR";
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${String((model.address() as AddressInfo).port)}/v1`;
  app = await buildApp();
  await app.ready();
  admin = await people.signIn((await people.makeUser({ admin: true })).email);
  member = await people.signIn((await people.makeUser()).email);
});

afterAll(async () => {
  await db.delete(chatSettings).where(eq(chatSettings.id, 1));
  await refreshChatSettings();
  await people.cleanUp();
  await app.close();
  await new Promise((resolve) => model.close(resolve));
});

describe("the chat agent's settings", () => {
  it("are admins' only", async () => {
    for (const [method, body] of [
      ["GetChatConfig", {}],
      ["SetChatConfig", { config: input() }],
      ["ResetChatConfig", {}],
      ["TestChatConfig", { config: input() }],
    ] as const) {
      expect((await call(member, `ChatService/${method}`, body)).failure).toBe("FORBIDDEN");
    }
  });

  it("are the install's until an admin sets them, checked as the install's are", async () => {
    expect((await call<Config>(admin, "ChatService/GetChatConfig")).body.config).toMatchObject({ source: "install" });
    for (const [extra, says] of [
      [{ provider: "openai" }, "provider"],
      [{ model: "" }, "Name a model"],
      [{ endpoint: "" }, "chat.endpoint"],
      [{ provider: "anthropic", apiKey: "" }, "needs a key"],
      [{ provider: "vertex", vertexProject: "X" }, "chat.vertex.project"],
      [{ provider: "bedrock", bedrockRegion: "nowhere" }, "chat.bedrock.region"],
      [{ provider: "bedrock", bedrockRegion: "us-east-2", model: "gpt-5" }, "Bedrock's name for a Claude model"],
      [{ maxTokens: 50000, contextTokens: 20000 }, "chat.contextTokens"],
      [{ endpoint: "https://someone:hunter2@models.example/v1" }, "no user or password"],
    ] as const) {
      const refused = await call(admin, "ChatService/SetChatConfig", { config: input(extra) });
      expect(refused.failure).toBe("BAD_CHAT_SETTINGS");
      expect(refused.message).toContain(says);
    }
  });

  it("keep the key sealed and never send it, keep it for its provider, and drop it with it", async () => {
    const saved = (await call<Config>(admin, "ChatService/SetChatConfig", { config: input() })).body.config;
    expect(saved).toMatchObject({ source: "admins", enabled: true, provider: "openai-compatible", model: "stand-in", keySet: true });
    expect(JSON.stringify(saved)).not.toContain("sk-first");
    const [row] = await db.select().from(chatSettings).where(eq(chatSettings.id, 1));
    expect(row?.apiKeyEncrypted).toBeTruthy();
    expect(row?.apiKeyEncrypted).not.toContain("sk-first");
    expect(currentChat()).toMatchObject({ model: "stand-in", apiKey: "sk-first", maxSteps: 8 });

    // Left out: kept.
    await call(admin, "ChatService/SetChatConfig", { config: input({ apiKey: "", model: "stand-in-2", maxSteps: 4 }) });
    expect(currentChat()).toMatchObject({ model: "stand-in-2", apiKey: "sk-first", maxSteps: 4 });
    // Another provider: the old one's key goes; Vertex keeps none.
    const vertex = (await call<Config>(admin, "ChatService/SetChatConfig", { config: input({ provider: "vertex", model: "", endpoint: "", apiKey: "sk-not-kept", vertexProject: "acyclix-dev" }) })).body.config;
    expect(vertex).toMatchObject({ provider: "vertex", model: "google/gemini-3.5-flash", keySet: false });
    expect((await db.select().from(chatSettings))[0]?.apiKeyEncrypted).toBeNull();
    // Bedrock signs in as the console's AWS identity: no key either, its model by default.
    const bedrock = (await call<Config>(admin, "ChatService/SetChatConfig", { config: input({ provider: "bedrock", model: "", endpoint: "", apiKey: "sk-not-kept", bedrockRegion: "us-east-2" }) })).body.config;
    expect(bedrock).toMatchObject({ provider: "bedrock", model: "anthropic.claude-sonnet-5", bedrockRegion: "us-east-2", keySet: false });
    expect((await db.select().from(chatSettings))[0]?.apiKeyEncrypted).toBeNull();
    expect(currentChat()).toMatchObject({ provider: "bedrock", endpoint: "https://bedrock-mantle.us-east-2.api.aws/anthropic", apiKey: "" });
  });

  it("send a key only to the address it was given for", async () => {
    await call(admin, "ChatService/SetChatConfig", { config: input() });
    expect(currentChat()).toMatchObject({ apiKey: "sk-first" });
    // Another address with no key given: the kept one isn't sent there, and goes.
    const elsewhere = (await call<Config>(admin, "ChatService/SetChatConfig", { config: input({ apiKey: "", endpoint: "http://127.0.0.1:9/v1" }) })).body.config;
    expect(elsewhere).toMatchObject({ keySet: false });
    expect(currentChat()).toMatchObject({ apiKey: "" });
    expect((await db.select().from(chatSettings))[0]?.apiKeyEncrypted).toBeNull();
    // Tried there, either: the model sees no key it wasn't given.
    await call(admin, "ChatService/SetChatConfig", { config: input() });
    seenKeys.length = 0;
    const moved = `http://127.0.0.1:${String((model.address() as AddressInfo).port)}/v1/`;
    await call(admin, "ChatService/TestChatConfig", { config: input({ apiKey: "", endpoint: `${moved}x/..` }) });
    expect(seenKeys.filter((k) => k.includes("sk-first"))).toEqual([]);
    // The same address, a trailing slash aside, still gets it.
    seenKeys.length = 0;
    await call(admin, "ChatService/TestChatConfig", { config: input({ apiKey: "", endpoint: `${endpoint}/` }) });
    expect(seenKeys).toContain("Bearer sk-first");

    // Vertex's and Bedrock's address isn't anyone's to choose.
    const pointed = await call(admin, "ChatService/SetChatConfig", { config: input({ provider: "vertex", model: "", apiKey: "", vertexProject: "acyclix-dev", endpoint: "https://attacker.example/v1" }) });
    expect(pointed.failure).toBe("BAD_CHAT_SETTINGS");
    expect((await call(admin, "ChatService/TestChatConfig", { config: input({ provider: "bedrock", model: "", apiKey: "", bedrockRegion: "us-east-2", endpoint: "https://attacker.example" }) })).failure).toBe("BAD_CHAT_SETTINGS");

    // Where they'd send its questions is in the audit log.
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.route, "vennir.console.v1.ChatService/TestChatConfig")).orderBy(desc(auditLog.id)).limit(1);
    expect(entry?.target).toMatchObject({ provider: "bedrock", endpoint: "https://attacker.example", bedrockRegion: "us-east-2" });
    await call(admin, "ChatService/ResetChatConfig");
  });

  it("use the install's key for the install's own provider when none is given", async () => {
    const install = config.chat;
    config.chat = { ...(chatFrom({ ...input(), apiKey: "sk-install", timeoutSeconds: null, maxSteps: null, maxTokens: null, contextTokens: null, vertexProject: "", vertexLocation: "", bedrockRegion: "", effort: "" }) as ChatConfig) };
    try {
      await call(admin, "ChatService/ResetChatConfig");
      const saved = (await call<Config>(admin, "ChatService/SetChatConfig", { config: input({ apiKey: "", model: "stand-in-3" }) })).body.config;
      expect(saved).toMatchObject({ source: "admins", model: "stand-in-3", keySet: true });
      // In effect, as every console reads it: with the install's key.
      expect(currentChat()).toMatchObject({ model: "stand-in-3", apiKey: "sk-install" });
      expect((await db.select().from(chatSettings))[0]?.apiKeyEncrypted).toBeNull();
      // Never to another address.
      await call(admin, "ChatService/SetChatConfig", { config: input({ apiKey: "", endpoint: "http://127.0.0.1:9/v1" }) });
      expect(currentChat()).toMatchObject({ apiKey: "" });
    } finally {
      config.chat = install;
      await call(admin, "ChatService/ResetChatConfig");
    }
  });

  it("can turn chat off, say why an admin's can't be used, and go back to the install's", async () => {
    await call(admin, "ChatService/SetChatConfig", { config: input({ enabled: false }) });
    expect(currentChat()).toBeNull();
    expect((await call<{ enabled?: boolean }>(member, "ChatService/GetChatSettings")).body.enabled ?? false).toBe(false);

    await call(admin, "ChatService/SetChatConfig", { config: input() });
    // A key the console can no longer unseal: chat off, and why, not the install's instead.
    await db.update(chatSettings).set({ apiKeyEncrypted: "v1.bad.bad.bad" }).where(eq(chatSettings.id, 1));
    await refreshChatSettings();
    expect(currentChat()).toBeNull();
    expect((await call<Config>(admin, "ChatService/GetChatConfig")).body.config?.["problem"]).toContain("can't be read");

    expect((await call<Config>(admin, "ChatService/ResetChatConfig")).body.config).toMatchObject({ source: "install" });
    expect(await db.select().from(chatSettings)).toHaveLength(0);
  });

  it("are tried before they're saved: whether the model answered, not what another server said", async () => {
    seenKeys.length = 0;
    const tried = (await call<Record<string, unknown>>(admin, "ChatService/TestChatConfig", { config: input({ apiKey: "sk-trying" }) })).body;
    expect(tried).toMatchObject({ ok: true, model: "stand-in", answer: "The docs don't cover that." });
    expect(seenKeys).toContain("Bearer sk-trying");
    // Nothing was saved.
    expect(await db.select().from(chatSettings)).toHaveLength(0);

    broken = true;
    const failed = (await call<Record<string, unknown>>(admin, "ChatService/TestChatConfig", { config: input() })).body;
    broken = false;
    expect(failed).toMatchObject({ ok: false, problem: "The model answered 500." });
    expect(JSON.stringify(failed)).not.toContain("hunter2");
  });
});
