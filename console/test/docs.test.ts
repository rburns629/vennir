// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { createUser } from "../src/db/queries.js";
import { users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { guideIndex, sectionsOf } from "../src/guideSearch.js";
import { headingsOf } from "../src/guides.js";
import { DOC_QUESTIONS } from "./docQuestions.js";
import { caller } from "./rpc.js";

let app: FastifyInstance;
let token: string;
const email = `docs-${randomUUID()}@example.com`;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  token = app.jwt.sign({ userId: user.id });
});

afterAll(async () => {
  await app.close();
  await db.delete(users).where(inArray(users.email, [email]));
});

const call = caller(() => app);
const listGuides = async () => (await call<{ guides: { id: string; title: string; section: string; sections?: { title: string; anchor: string }[] }[] }>(token, "GuideService/ListGuides")).body.guides;
const getGuide = (id: string, as: string | undefined = token) => call<{ markdown: string }>(as, "GuideService/GetGuide", { id });

describe("the in-app guides", () => {
  it("lists the guides in order, the walkthrough first", async () => {
    const docs = await listGuides();
    expect(docs[0]).toMatchObject({ id: "01-getting-started", title: "Try Vennir end to end", section: "guides", kind: "guide" });
    expect(docs.map((d) => d.id)).toEqual([...docs.map((d) => d.id)].sort());
  });

  it("serves a guide as markdown, and every link between guides resolves", async () => {
    const all = await listGuides();
    const docs = all.filter((d) => d.section === "guides");
    // The API reference is a page of its own, not a guide file; a reference
    // doc is linked by its own name (setup.md), as the Docs page resolves it.
    const reference = all.filter((d) => d.section === "reference").map((d) => d.id.replace(/^reference-/, ""));
    const ids = new Set([...docs.map((d) => d.id), ...reference, "api-reference"]);
    for (const { id } of docs) {
      const page = await getGuide(id);
      expect(page.code).toBe("ok");
      for (const [, target] of page.body.markdown.matchAll(/\]\(([a-zA-Z0-9_-]+)\.md\)/g)) {
        expect(ids, `${id} links to ${String(target)}`).toContain(target);
      }
    }
  });

  it("refuses anything that isn't a plain guide name", async () => {
    expect((await getGuide("../../package")).code).toBe("invalid_argument");
    expect((await getGuide("no-such-guide")).code).toBe("not_found");
  });

  it("is for signed-in users only", async () => {
    expect((await call(undefined, "GuideService/ListGuides")).code).toBe("unauthenticated");
  });
});

describe("the platform's own docs", () => {
  const sources = readFileSync("docs/reference/SOURCES", "utf-8")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.trim().split(/\s+/) as [string, string, string]);

  it("are copies of the repository's, current (make console-docs)", () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const [id, , path] of sources) {
      const copy = readFileSync(join("docs/reference", `${id}.md`), "utf-8");
      expect(copy === readFileSync(join("..", path), "utf-8"), `console/docs/reference/${id}.md is behind ${path}: run make console-docs`).toBe(true);
    }
  });

  it("come with the figures they draw, current, for signed-in users only", async () => {
    const figures = readdirSync("../docs/architecture").filter((name) => name.endsWith(".svg"));
    expect(figures).toContain("6-the-pieces.svg");
    expect(readdirSync("docs/reference/architecture").sort()).toEqual(figures.sort());
    for (const name of figures) {
      expect(readFileSync(join("docs/reference/architecture", name), "utf-8") === readFileSync(join("../docs/architecture", name), "utf-8"), `${name} is behind: run make console-docs`).toBe(true);
    }
    const figure = await call<{ svg: string }>(token, "GuideService/GetGuideImage", { path: "architecture/6-the-pieces.svg" });
    expect(figure.body.svg).toContain("<svg");
    expect((await call(token, "GuideService/GetGuideImage", { path: "architecture/none.svg" })).code).toBe("not_found");
    // Never outside the figures' folder.
    for (const path of ["../SOURCES", "architecture/../../../package.json", "architecture/6-the-pieces.md", "/etc/passwd"]) {
      expect((await call(token, "GuideService/GetGuideImage", { path })).code).toBe("invalid_argument");
    }
    expect((await call(undefined, "GuideService/GetGuideImage", { path: "architecture/6-the-pieces.svg" })).code).toBe("unauthenticated");
  });

  it("are listed after the guides, as the reference", async () => {
    const docs = await listGuides();
    const reference = docs.filter((d) => d.section === "reference");
    expect(reference.map((d) => d.id).sort()).toEqual(sources.map(([id]) => `reference-${id}`).sort());
    expect(docs.findIndex((d) => d.section === "reference")).toBeGreaterThan(docs.findLastIndex((d) => d.section === "guides"));
    expect((await getGuide("reference-operations")).body.markdown).toContain("## Upgrading");
    // Each says what it is; design history is the decisions.
    expect(docs.find((d) => d.id === "01-getting-started")).toMatchObject({ kind: "guide" });
    expect(docs.find((d) => d.id === "reference-operations")).toMatchObject({ kind: "operating" });
    expect(docs.find((d) => d.id === "reference-assessment")).toMatchObject({ kind: "history" });
    // With their sections, which the Docs page shows a page each.
    const operations = docs.find((d) => d.id === "reference-operations");
    expect(operations?.sections).toContainEqual({ title: "Upgrading", anchor: "upgrading" });
    for (const [id, kind] of sources) expect(["current", "operating", "history"], `${id}'s kind`).toContain(kind);
  });

  it("leaves design history out of a search unless asked: it answers why, not what is", async () => {
    type Hits = { hits: { guide: string; kind: string }[] };
    const decisions = "decisions rejected Temporal message broker";
    const plain = (await call<Hits>(token, "GuideService/SearchGuides", { query: decisions, limit: 20 })).body.hits;
    expect(plain.some((h) => h.kind === "history")).toBe(false);
    const why = (await call<Hits>(token, "GuideService/SearchGuides", { query: decisions, limit: 20, includeHistory: true })).body.hits;
    expect(why.some((h) => h.guide === "reference-assessment" && h.kind === "history")).toBe(true);
  });
});

describe("searching the docs", () => {
  type Hits = { hits: { guide: string; heading: string; excerpt: string }[] };
  const search = async (query: string) => (await call<Hits>(token, "GuideService/SearchGuides", { query })).body.hits;

  it("finds the section a question is about, in the guides and the reference", async () => {
    // What the agent reads: the best few, not only the first.
    const top = async (query: string) => (await search(query)).slice(0, 3).map((h) => `${h.guide} :: ${h.heading}`);
    expect(await top("how do I back up the databases")).toContain("reference-operations :: Backups");
    expect((await top("what is a DAG")).some((h) => h.startsWith("03-what-is-a-dag"))).toBe(true);
    expect((await top("wiring types types.yaml default provider")).some((h) => h.startsWith("reference-catalog-guide"))).toBe(true);
    expect(await search("zzzz qqqq")).toEqual([]);
  });

  it("finds what answers the question set's questions among its best five: at least 90% (docQuestions.ts)", async () => {
    const index = await guideIndex();
    const misses = DOC_QUESTIONS.filter(({ question, answers }) => {
      const hits = index.search(question, 5);
      return !answers.some((answer) => {
        const [guide, heading = ""] = answer.split(" :: ");
        return hits.some((h) => h.guide === guide && h.heading.includes(heading));
      });
    });
    const recall = 1 - misses.length / DOC_QUESTIONS.length;
    // Every miss said, so a change to the ranking shows what it moved.
    console.info(`search: ${String(DOC_QUESTIONS.length - misses.length)}/${String(DOC_QUESTIONS.length)} found; missed: ${misses.map((m) => m.question).join("; ") || "none"}`);
    expect(DOC_QUESTIONS.length).toBeGreaterThanOrEqual(40);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });

  it("refuses an empty question", async () => {
    expect((await call(token, "GuideService/SearchGuides", { query: "" })).code).toBe("invalid_argument");
  });

  it("cuts a doc at its headings, nested, leaving code blocks whole", () => {
    const sections = sectionsOf("g", "# Title\nintro\n## A\na text\n### B\n```\n# not a heading\n```\nb text\n## C\nc");
    expect(sections.map((x) => x.heading)).toEqual(["Title", "A", "A > B", "C"]);
    expect(sections[2]?.text).toContain("# not a heading");
  });
});

describe("a doc's sections", () => {
  it("are its ## headings outside code, as they read, a repeated one numbered as the page numbers it", () => {
    const md = "# T\n\n## The `chat` agent\n\n```\n## not one\n```\n\n### Deeper\n\n## Backups\n\n## Backups\n\n## See [the API](05.md)\n";
    expect(headingsOf(md)).toEqual([
      { title: "The chat agent", anchor: "the-chat-agent" },
      { title: "Backups", anchor: "backups" },
      { title: "Backups", anchor: "backups-1" },
      { title: "See the API", anchor: "see-the-api" },
    ]);
  });
});
