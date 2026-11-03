// SPDX-License-Identifier: MIT
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { Type } from "@sinclair/typebox";

// console/docs/*.md, copied into the image (see the Dockerfile): the guides
// for platform teams, shipped with the code they describe, so a deploy can
// never leave them stale. Listed by file name, hence the numeric prefixes.
// And console/docs/reference/: the platform's own docs (architecture,
// operations, the security model, the catalog's guide), copied from the
// repository (`make console-docs`), since the chat agent answers from them
// too (decision 24). The repository is public, so none of it is news; none
// of it holds a credential.
const DOCS_DIR = config.docsDir;
const REFERENCE = "reference-";

/** What a doc is (decision 24): a guide to using Vertra; how it works now;
 * installing and running it; or design history, which answers "why",
 * never "what is". */
export type GuideKind = "guide" | "current" | "operating" | "history";

export interface GuideSummary {
  id: string;
  title: string;
  /** guides: for using Vertra; reference: the platform's own docs. */
  section: "guides" | "reference";
  kind: GuideKind;
  /** Its ## headings, in order, each with its anchor. */
  sections: { title: string; anchor: string }[];
}

/** A heading's anchor, as the Docs page's rehype-slug makes it (GitHub's). */
export function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** A doc's ## headings outside code, as they read (no markdown) and with their anchors; a repeated one numbered -1, -2… */
export function headingsOf(markdown: string): { title: string; anchor: string }[] {
  const out: { title: string; anchor: string }[] = [];
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^## (.+?)\s*#*\s*$/.exec(line);
    if (!match?.[1]) continue;
    const title = match[1].replace(/`([^`]*)`/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*/g, "");
    const base = anchor(title);
    const times = seen.get(base) ?? 0;
    seen.set(base, times + 1);
    out.push({ title, anchor: times === 0 ? base : `${base}-${String(times)}` });
  }
  return out;
}

const KINDS: readonly string[] = ["current", "operating", "history"];

/** The reference docs' kinds, from reference/SOURCES ("<id> <kind> <path>"); a doc missing there is "current". */
async function referenceKinds(): Promise<Map<string, GuideKind>> {
  try {
    const sources = await readFile(join(DOCS_DIR, "reference", "SOURCES"), "utf-8");
    const kinds = new Map<string, GuideKind>();
    for (const line of sources.split("\n")) {
      const [id, kind] = line.trim().split(/\s+/);
      if (id && !id.startsWith("#") && kind && KINDS.includes(kind)) kinds.set(id, kind as GuideKind);
    }
    return kinds;
  } catch {
    return new Map();
  }
}

/** Kept to exactly `[a-zA-Z0-9_-]+`: an id becomes a path component in
 * readGuide, and this is what keeps that safe from traversal without
 * canonicalizing and comparing resolved paths by hand. */
export const GuideId = Type.String({ pattern: "^[a-zA-Z0-9_-]+$" });

function titleFromMarkdown(content: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim() ?? fallback;
}

async function markdownIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    // No docs folder (e.g. running from source outside the image): none,
    // not an error; nothing else in the console needs it.
    return [];
  }
}

export async function listGuides(): Promise<GuideSummary[]> {
  const kinds = await referenceKinds();
  const guides: GuideSummary[] = [];
  for (const [dir, section, prefix] of [
    [DOCS_DIR, "guides", ""],
    [join(DOCS_DIR, "reference"), "reference", REFERENCE],
  ] as const) {
    for (const entry of await markdownIn(dir)) {
      const content = await readFile(join(dir, entry), "utf-8");
      const name = entry.replace(/\.md$/, "");
      const kind: GuideKind = section === "guides" ? "guide" : (kinds.get(name) ?? "current");
      guides.push({ id: prefix + name, title: titleFromMarkdown(content, entry), section, kind, sections: headingsOf(content) });
    }
  }
  return guides;
}

/** A figure's path from the docs, such as architecture/6-the-pieces.svg:
 * one folder and an SVG, in lowercase words, so it can't leave the
 * figures' folder. */
export const GuideImagePath = Type.String({ pattern: "^[a-z0-9-]+/[a-z0-9-]+\\.svg$" });

/** A figure the reference docs draw, as SVG text, or undefined if there's
 * none there. `path` must match GuideImagePath (checked by the caller). */
export async function readGuideImage(path: string): Promise<string | undefined> {
  try {
    return await readFile(join(DOCS_DIR, "reference", path), "utf-8");
  } catch {
    return undefined;
  }
}

/** A guide's markdown, or undefined if there's none by that id. `id` must
 * match GuideId (checked by the caller). */
export async function readGuide(id: string): Promise<string | undefined> {
  const path = id.startsWith(REFERENCE) ? join(DOCS_DIR, "reference", `${id.slice(REFERENCE.length)}.md`) : join(DOCS_DIR, `${id}.md`);
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}
