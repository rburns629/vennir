// SPDX-License-Identifier: MIT
/**
 * Scores the chat agent's answers (decision 24, Correctness) on the question
 * set (test/docQuestions.ts), against whatever model a console has: each
 * question asked through ChatService/Ask as a person would, as the token's
 * user, one at a time. For each answer: whether it cites a section that
 * answers the question, whether it's flagged as citing nothing it found,
 * what it must and mustn't say, and how long it took. Writes
 * chat-eval-results/<model>-<time>.json, to compare models and prompts.
 *
 * And the ordering tasks (test/chatTasks.ts), judged by what the agent did:
 * the tools it used, in order; the cart it proposed, or that it proposed
 * none; what its answer must say. And the guardrails: questions that
 * aren't about Vennir (chatTasks.ts's OFF_TOPIC) answered with the scope
 * answer, and none of the question set's refused.
 *
 *   VENNIR_TOKEN=... npm run chat-eval            # every question, then the tasks
 *   VENNIR_TOKEN=... npm run chat-eval -- 5       # the first five questions, then the tasks
 *   TASKS_ONLY=1 VENNIR_TOKEN=... npm run chat-eval
 *
 * CONSOLE_URL (http://localhost:18080) and TEAM (the token's first) as needed.
 * A model's run, not CI: real models are slow, and their answers vary.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { CHAT_TASKS, OFF_TOPIC } from "../test/chatTasks.js";
import { DOC_QUESTIONS } from "../test/docQuestions.js";

const consoleUrl = (process.env["CONSOLE_URL"] ?? "http://localhost:18080").replace(/\/+$/, "");
const token = process.env["VENNIR_TOKEN"] ?? "";
const limit = process.env["TASKS_ONLY"] ? 0 : Number(process.argv[2] ?? DOC_QUESTIONS.length);

interface Answer {
  text?: string;
  citations?: { guide: string; heading: string; link: string }[];
  cart?: { team: string; actions: string[] };
  uncited?: boolean;
  offTopic?: boolean;
  contextPercent?: number;
  steps?: { tool: string; ok: boolean }[];
  model?: string;
  code?: string;
  message?: string;
}

async function call<T>(method: string, body: unknown): Promise<T> {
  const response = await fetch(`${consoleUrl}/api/vennir.console.v1.${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function main(): Promise<void> {
  if (!token) throw new Error("VENNIR_TOKEN: a token for the console");
  const settings = await call<{ enabled?: boolean; model?: string }>("ChatService/GetChatSettings", {});
  if (!settings.enabled) throw new Error("Chat is off on this console: set chat.model.");
  const me = await call<{ teamNames?: string[] }>("AuthService/GetMe", {});
  const team = process.env["TEAM"] ?? me.teamNames?.[0] ?? "";
  const rows = [];
  for (const q of DOC_QUESTIONS.slice(0, limit)) {
    const started = Date.now();
    const a = await call<Answer>("ChatService/Ask", { team, messages: [{ role: "user", content: q.question }] });
    const ms = Date.now() - started;
    const text = a.text ?? "";
    const cited = (a.citations ?? []).some((c) =>
      q.answers.some((answer) => {
        const [guide, heading = ""] = answer.split(" :: ");
        return c.guide === guide && c.heading.includes(heading);
      }),
    );
    const missing = (q.mustSay ?? []).filter((s) => !text.includes(s));
    const said = (q.mustNotSay ?? []).filter((s) => text.includes(s));
    const row = {
      question: q.question,
      error: a.code ? `${a.code}: ${a.message ?? ""}` : null,
      citedAnAnswer: cited,
      uncited: a.uncited ?? false,
      offTopic: a.offTopic ?? false,
      citations: (a.citations ?? []).map((c) => `${c.guide} :: ${c.heading}`),
      missing,
      said,
      steps: (a.steps ?? []).map((s) => (s.ok ? s.tool : `${s.tool}(failed)`)),
      seconds: Math.round(ms / 100) / 10,
      answer: text,
    };
    rows.push(row);
    console.log(
      `${row.error ? "ERROR" : row.offTopic ? "REFUSED" : row.citedAnAnswer ? "cited" : row.uncited ? "UNCITED" : "other"}  ${String(row.seconds).padStart(5)}s  ${q.question}` +
        (missing.length > 0 ? `  [missing: ${missing.join(", ")}]` : "") +
        (said.length > 0 ? `  [said: ${said.join(", ")}]` : ""),
    );
  }
  // The ordering tasks: what it did, not only what it said.
  const tasks = [];
  for (const t of CHAT_TASKS) {
    const started = Date.now();
    const a = await call<Answer>("ChatService/Ask", { team, messages: [{ role: "user", content: t.request }] });
    const used = (a.steps ?? []).map((s) => s.tool);
    let at = 0;
    for (const tool of used) if (tool === t.tools[at]) at++;
    const cart = a.cart?.actions ?? null;
    const expected = t.cart;
    const cartRight =
      expected === undefined ? true : expected === null ? cart === null || cart.length === 0 : cart !== null && expected.every((x) => cart.includes(x));
    const text = (a.text ?? "").toLowerCase();
    const missing = (t.mustSay ?? []).filter((w) => !text.includes(w.toLowerCase()));
    const row = {
      request: t.request,
      error: a.code ? `${a.code}: ${a.message ?? ""}` : null,
      toolsInOrder: at === t.tools.length,
      cartRight,
      missing,
      steps: used,
      cart,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      answer: a.text ?? "",
    };
    tasks.push(row);
    const passed = !row.error && row.toolsInOrder && row.cartRight && missing.length === 0;
    console.log(
      `${passed ? "done" : "FAILED"}  ${String(row.seconds).padStart(5)}s  ${t.request}  [${used.join(" > ")}] cart: ${cart ? cart.join(", ") : "none"}` +
        (missing.length > 0 ? `  [missing: ${missing.join(", ")}]` : ""),
    );
  }

  // The guardrails: what isn't about Vennir gets the scope answer.
  const refusals = [];
  for (const q of OFF_TOPIC) {
    const started = Date.now();
    const a = await call<Answer>("ChatService/Ask", { team, messages: [{ role: "user", content: q }] });
    const row = {
      question: q,
      error: a.code ? `${a.code}: ${a.message ?? ""}` : null,
      offTopic: a.offTopic ?? false,
      // Past the scope check, and not shown: from neither the docs nor the platform.
      held: a.uncited ?? false,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      answer: a.text ?? "",
    };
    refusals.push(row);
    console.log(`${row.offTopic ? "refused" : row.held ? "held" : row.error ? "ERROR" : "ANSWERED"}  ${String(row.seconds).padStart(5)}s  ${q}`);
  }

  const answered = rows.filter((r) => !r.error);
  const summary = {
    model: settings.model,
    at: new Date().toISOString(),
    questions: rows.length,
    errors: rows.length - answered.length,
    citedAnAnswer: answered.filter((r) => r.citedAnAnswer).length,
    uncited: answered.filter((r) => r.uncited).length,
    refusedInScope: answered.filter((r) => r.offTopic).length,
    mustSayMissed: rows.filter((r) => r.missing.length > 0).length,
    mustNotSaySaid: rows.filter((r) => r.said.length > 0).length,
    medianSeconds: median(rows.map((r) => r.seconds)),
    slowestSeconds: rows.length > 0 ? Math.max(...rows.map((r) => r.seconds)) : 0,
    tasks: tasks.length,
    tasksDone: tasks.filter((t) => !t.error && t.toolsInOrder && t.cartRight && t.missing.length === 0).length,
    offTopic: refusals.length,
    offTopicRefused: refusals.filter((r) => r.offTopic).length,
    // Refused, or past the check and not shown: either way, not answered.
    offTopicNotAnswered: refusals.filter((r) => r.offTopic || r.held).length,
  };
  console.log(`\n${JSON.stringify(summary, null, 2)}`);
  mkdirSync("chat-eval-results", { recursive: true });
  const file = `chat-eval-results/${String(settings.model).replace(/[^a-zA-Z0-9.-]/g, "_")}-${summary.at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ summary, rows, tasks, refusals }, null, 2));
  console.log(`Written: ${file}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
