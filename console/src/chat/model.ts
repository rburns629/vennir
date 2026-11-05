// SPDX-License-Identifier: MIT
/**
 * The chat agent's model (decision 24): one interface, so the agent's loop,
 * its tools and its checks are the same whatever answers. Behind it, one
 * adapter per API shape, not per cloud: openai-compatible (LM Studio,
 * Ollama; and `vertex`, Gemini on Vertex AI's compatible endpoint) and
 * Anthropic's Messages API (Claude, with an API key; and `bedrock`, Claude in
 * Amazon Bedrock, its requests signed as the console's AWS identity). A
 * cloud's sign-in (a key from a Secret; on Vertex, the console's Workload
 * Identity; on Bedrock, its Pod Identity) is the adapter's, never the agent's.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ChatConfig } from "../config.js";
import { gcpMetadataToken } from "../gcpMetadata.js";
import { bedrockFetch } from "./bedrock.js";
import { currentChat } from "./settings.js";

export interface ToolCall {
  id: string;
  name: string;
  /** As the model wrote them: JSON, unchecked. */
  arguments: string;
  /** The provider's own data on the call, sent back as it came (Gemini's thought signature). */
  extra?: unknown;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  // raw: the model's own reply, as its API gave it (Claude's thinking
  // blocks with it), sent back unchanged on the next call of the same turn.
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** A JSON Schema for an object: the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelReply {
  content: string;
  toolCalls: ToolCall[];
  /** stop, tool_calls, length, content_filter: as the provider says. */
  finishReason: string;
  /** The reply as the provider gave it, for the adapter to send back. */
  raw?: unknown;
  /** Tokens, as the provider counted them: what it cost, what caching saved. */
  usage?: Usage;
}

export interface Usage {
  /** Input not read from the cache (Anthropic's input_tokens; OpenAI's prompt less its cached). */
  input: number;
  /** Input read from the cache: about a tenth of the price on Anthropic's API. */
  cacheRead: number;
  /** Input written to the cache: a quarter more than input, once. */
  cacheWrite: number;
  output: number;
}

export interface CompleteOptions {
  /** Answer in words; the tools are still described (the history may hold their calls). */
  noTools?: boolean;
  /** A one-word judgment (the scope check): no thinking where the model takes that, a short reply. */
  quick?: boolean;
  signal?: AbortSignal | undefined;
}

export interface ChatModel {
  readonly name: string;
  complete(messages: ChatMessage[], tools: ToolSpec[], options?: CompleteOptions): Promise<ModelReply>;
}

/**
 * The model couldn't be reached, or answered with something unusable.
 * `summary` leaves out what the server answered: an admin testing an
 * endpoint sees whether it answered, not another service's reply.
 */
export class ModelUnavailable extends Error {
  constructor(
    message: string,
    readonly summary: string = message,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** A reasoning model's thinking (Qwen's <think>...</think>): not the answer. */
export function withoutThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "").trim();
}

/** Waits before asking a busy model again, in ms. */
const RETRIES = [1000, 3000];

/**
 * OpenAI's chat completions, which LM Studio, Ollama and Vertex (for
 * Gemini) speak too. On Vertex (`vertex`): signed in with a token got for
 * each call (the console's Workload Identity's, cached for its hour), and
 * Gemini's thinking set with reasoning_effort: the install's effort, or
 * the least for a quick call.
 */
export class OpenAICompatible implements ChatModel {
  constructor(
    private readonly options: { endpoint: string; model: string; apiKey: string; timeoutSeconds: number; maxTokens: number },
    private readonly fetchFn: typeof fetch = fetch,
    private readonly vertex?: { token: () => Promise<string>; effort: "low" | "medium" | "high" | null },
  ) {}

  get name(): string {
    return this.options.model;
  }

  async complete(messages: ChatMessage[], tools: ToolSpec[], options: CompleteOptions = {}): Promise<ModelReply> {
    const { signal } = options;
    const effort = this.vertex ? (options.quick ? "minimal" : this.vertex.effort) : null;
    const vertex = this.vertex !== undefined;
    const body = {
      model: this.options.model,
      temperature: 0.2,
      // A quick call's one word, with room for what thinking it still does.
      max_tokens: options.quick && this.vertex ? 256 : this.options.maxTokens,
      ...(effort ? { reasoning_effort: effort } : {}),
      messages: messages.map((m) =>
        m.role === "tool"
          ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
          : m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0
            ? {
                role: "assistant",
                content: m.content,
                tool_calls: m.toolCalls.map((c, i) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.arguments },
                  ...(c.extra !== undefined
                    ? { extra_content: c.extra }
                    : // Gemini refuses a step's first call without a thought
                      // signature: one it didn't make (the console's own
                      // first search) gets the placeholder Google allows.
                      vertex && i === 0 && m.toolCalls?.every((x) => x.extra === undefined)
                      ? { extra_content: { google: { thought_signature: "skip_thought_signature_validator" } } }
                      : {}),
                })),
              }
            : { role: m.role, content: m.content },
      ),
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
            ...(options.noTools ? { tool_choice: "none" } : {}),
          }
        : {}),
    };
    const timeout = AbortSignal.timeout(this.options.timeoutSeconds * 1000);
    let response: Response;
    // A busy model (429, 503: Vertex's shared capacity, a rate limit) is
    // asked again, twice, after a moment; one that doesn't answer isn't (a
    // slow local model would only be slower).
    for (let attempt = 0; ; attempt++) {
      try {
        const key = this.vertex ? await this.vertex.token() : this.options.apiKey;
        response = await this.fetchFn(`${this.options.endpoint}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        // The connection's error, which can name hosts and say what they
        // answered, is logged (chat_model_unavailable), never shown.
        throw new ModelUnavailable(
          `The model at ${this.options.endpoint} didn't answer: ${error instanceof Error ? error.message : String(error)}`,
          `The model at ${this.options.endpoint} didn't answer.`,
          { cause: error },
        );
      }
      if ((response.status !== 429 && response.status !== 503) || attempt >= RETRIES.length || signal?.aborted) break;
      await response.body?.cancel();
      const after = Number(response.headers.get("retry-after"));
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : (RETRIES[attempt] ?? 0)));
    }
    if (!response.ok) {
      throw new ModelUnavailable(`The model answered ${String(response.status)}: ${(await response.text()).slice(0, 300)}`, `The model answered ${String(response.status)}.`);
    }
    const data = (await response.json()) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      choices?: {
        finish_reason?: string;
        message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown }[] };
      }[];
    };
    const choice = data.choices?.[0];
    if (!choice?.message) throw new ModelUnavailable("The model's answer had no message.");
    return {
      content: withoutThinking(choice.message.content ?? ""),
      toolCalls: (choice.message.tool_calls ?? []).map((c, i) => ({
        id: c.id || `call-${String(i)}`,
        name: c.function?.name ?? "",
        arguments: c.function?.arguments ?? "{}",
        ...(c.extra_content !== undefined ? { extra: c.extra_content } : {}),
      })),
      finishReason: choice.finish_reason ?? "stop",
      ...(data.usage
        ? {
            usage: {
              input: (data.usage.prompt_tokens ?? 0) - (data.usage.prompt_tokens_details?.cached_tokens ?? 0),
              cacheRead: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
              cacheWrite: 0,
              output: data.usage.completion_tokens ?? 0,
            },
          }
        : {}),
    };
  }
}

/**
 * A quick call's thinking and length, for a one-word reply. Most Claude
 * models turn thinking off with `disabled`; Sonnet 5.5 refuses that and
 * takes `between_tools`; Opus 5.5 and Fable (and Mythos) always think, so
 * they think least (low effort) with room for it before the word. By the
 * model's name, which on Bedrock carries an `anthropic.` prefix.
 */
export function quickCall(model: string): Pick<Anthropic.MessageCreateParamsNonStreaming, "max_tokens" | "thinking" | "output_config"> {
  if (/claude-sonnet-5-5/.test(model)) return { max_tokens: 64, thinking: { type: "between_tools" } };
  if (/claude-(opus-5-5|fable-|mythos-)/.test(model)) return { max_tokens: 2048, output_config: { effort: "low" } };
  return { max_tokens: 64, thinking: { type: "disabled" } };
}

/**
 * Claude, through Anthropic's Messages API. The system prompt goes in
 * `system`; each assistant turn of the loop goes back as Claude wrote it
 * (raw, thinking blocks included, as the API requires within a turn); tool
 * results go back together in one user message. The tools and system
 * prompt are the same on every call, so the request is cached (a cached
 * read costs a tenth). Thinking is the model's own default (adaptive);
 * effort, when set, is the settings' effort.
 */
export class AnthropicMessages implements ChatModel {
  private readonly client: Anthropic;

  constructor(
    private readonly options: { model: string; apiKey: string; endpoint: string; timeoutSeconds: number; maxTokens: number; effort: "low" | "medium" | "high" | null },
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey: options.apiKey, ...(options.endpoint ? { baseURL: options.endpoint } : {}), maxRetries: 2 });
  }

  get name(): string {
    return this.options.model;
  }

  /** The conversation in the Messages API's shape. */
  static messagesOf(messages: ChatMessage[]): { system: string; messages: Anthropic.MessageParam[] } {
    const system = messages.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n\n");
    const out: Anthropic.MessageParam[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        out.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        if (m.raw !== undefined) {
          out.push({ role: "assistant", content: m.raw as Anthropic.ContentBlockParam[] });
          continue;
        }
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const call of m.toolCalls ?? []) {
          let input: unknown = {};
          try {
            input = JSON.parse(call.arguments || "{}");
          } catch {
            input = {};
          }
          blocks.push({ type: "tool_use", id: call.id, name: call.name, input });
        }
        if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
      } else if ("toolCallId" in m) {
        const result: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
        const last = out.at(-1);
        // Every result of one turn's calls in one user message.
        if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
          last.content.push(result);
        } else {
          out.push({ role: "user", content: [result] });
        }
      }
    }
    return { system, messages: out };
  }

  async complete(messages: ChatMessage[], tools: ToolSpec[], options: CompleteOptions = {}): Promise<ModelReply> {
    const { signal } = options;
    const { system, messages: converted } = AnthropicMessages.messagesOf(messages);
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        {
          model: this.options.model,
          ...(options.quick ? quickCall(this.options.model) : { max_tokens: this.options.maxTokens }),
          ...(system ? { system } : {}),
          messages: converted,
          ...(tools.length > 0
            ? {
                tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })),
                ...(options.noTools ? { tool_choice: { type: "none" as const } } : {}),
              }
            : {}),
          ...(this.options.effort && !options.quick ? { output_config: { effort: this.options.effort } } : {}),
          cache_control: { type: "ephemeral" },
        },
        { timeout: this.options.timeoutSeconds * 1000, ...(signal ? { signal } : {}) },
      );
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new ModelUnavailable(
          `Claude answered ${String(error.status ?? "no status")}: ${error.message.slice(0, 300)}`,
          error.status ? `Claude answered ${String(error.status)}.` : "Claude didn't answer.",
          { cause: error },
        );
      }
      throw error;
    }
    if (response.stop_reason === "refusal") {
      return { content: "I can't help with that one.", toolCalls: [], finishReason: "refusal" };
    }
    return {
      content: response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim(),
      toolCalls: response.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, arguments: JSON.stringify(b.input) }] : [])),
      finishReason: response.stop_reason ?? "end_turn",
      raw: response.content,
      usage: {
        input: response.usage.input_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? 0,
        cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
        output: response.usage.output_tokens,
      },
    };
  }
}

/** The model in effect (chat/settings.ts), or null when chat is off. */
export function chatModel(): ChatModel | null {
  const c = currentChat();
  return c ? modelFor(c) : null;
}

/** A model for these settings: the one in effect, or ones an admin is trying. */
export function modelFor(c: ChatConfig): ChatModel {
  if (c.provider === "anthropic") return new AnthropicMessages(c);
  // Bedrock: the same Messages API, at Bedrock's address, each request
  // signed (SigV4) instead of a key. The SDK insists on a key: a
  // placeholder, which the signer drops.
  if (c.provider === "bedrock") {
    return new AnthropicMessages(
      c,
      new Anthropic({ apiKey: "bedrock-signed", baseURL: c.endpoint, fetch: bedrockFetch(c.bedrockRegion), maxRetries: 2 }),
    );
  }
  // On Vertex, a key is an access token used instead of the console's
  // identity: for proving it off GKE (it lasts an hour).
  if (c.provider === "vertex") return new OpenAICompatible(c, fetch, { token: c.apiKey ? () => Promise.resolve(c.apiKey) : gcpMetadataToken, effort: c.effort });
  return new OpenAICompatible(c);
}
