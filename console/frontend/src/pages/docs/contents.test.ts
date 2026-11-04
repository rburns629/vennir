// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { API_REFERENCE_ID } from "../ApiReference";
import { contentsOf, docTarget, IN_DEPTH, pageOf, pagesOf, placeOf, plain, POPULAR, sectionHolding, sectionsOf, slug, START_HERE, SYMPTOMS, TASKS } from "./contents";

// What the console serves (../../../src/guides.ts): its guides, and the platform's docs copied into reference/.
const files = {
  ...import.meta.glob<string>("../../../../docs/*.md", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob<string>("../../../../docs/reference/*.md", { query: "?raw", import: "default", eager: true }),
};
const served = Object.entries(files).map(([path, markdown]) => {
  const name = path.split("/").at(-1)?.replace(/\.md$/, "") ?? "";
  const id = path.includes("/reference/") ? `reference-${name}` : name;
  return { id, title: name, section: "guides" as const, kind: "guide", sections: sectionsOf(markdown) };
});

describe("the docs' contents", () => {
  it("places every doc the console serves, and every section of those shown a section to a page", () => {
    expect(served.length).toBeGreaterThan(15);
    const more = contentsOf(served).find((c) => c.id === "more");
    expect(more ? pagesOf(more.children).map((p) => p.key) : []).toEqual([]);
  });

  it("nests a long doc's sections under it, and reads on from one page to the next", () => {
    const categories = contentsOf(served);
    const place = placeOf(categories, "reference-security-model", "where-secret-values-live");
    expect(place?.category.title).toBe("How Vennir works");
    expect(place?.groups.map((g) => g.label)).toEqual(["Security model", "Secrets"]);
    expect(place?.previous?.page.key).toBe("reference-security-model/tokens-for-another-cloud");
    expect(place?.next?.page.key).toBe("reference-security-model/how-a-secret-reaches-a-step");
  });

  const md = "# Ops\n\nIntro.\n\n## Upgrading\n\nUp.\n\n### Reused tags\n\nTags.\n\n```\n## not a section\n```\n\n## Backups\n\nNightly.\n";

  it("shows a long doc a page at a time, each section's headings a level up", () => {
    expect(pageOf(md)).toBe("# Ops\n\nIntro.\n");
    expect(pageOf(md, "upgrading")).toBe("# Upgrading\n\nUp.\n\n## Reused tags\n\nTags.\n\n```\n## not a section\n```\n");
    expect(pageOf(md, "backups")).toBe("# Backups\n\nNightly.\n");
    expect(pageOf(md, "gone")).toBeNull();
  });

  it("finds the page a heading's anchor is on", () => {
    expect(sectionHolding(md, "reused-tags")).toBe("upgrading");
    expect(sectionHolding(md, "backups")).toBe("backups");
    expect(sectionHolding(md, "ops")).toBeUndefined();
  });

  it("finds the doc a link between docs means, however the repository wrote its path", () => {
    const ids = new Set(["01-getting-started", "06-database-schemas", "api-reference", "reference-setup", "reference-security-model", "reference-clouds-gcp", "reference-catalog-onboarding-with-ai"]);
    expect(docTarget("security-model.md#guardrails", ids)).toBe("/docs/reference-security-model#guardrails");
    expect(docTarget("../setup.md", ids)).toBe("/docs/reference-setup");
    expect(docTarget("clouds/gcp.md", ids)).toBe("/docs/reference-clouds-gcp");
    expect(docTarget("../console/docs/06-database-schemas.md", ids)).toBe("/docs/06-database-schemas");
    expect(docTarget("docs/onboarding-with-ai.md", ids)).toBe("/docs/reference-catalog-onboarding-with-ai");
    expect(docTarget("api-reference.md", ids)).toBe("/docs/api-reference");
    expect(docTarget("../TODO.md", ids)).toBeNull();
  });

  it("lists a doc's sections as rehype-slug anchors them, skipping code", () => {
    expect(sectionsOf("# T\n\n## The `chat` agent\n\n```\n## no\n```\n\n## Backups\n\n## Backups\n")).toEqual([
      { title: "The chat agent", anchor: "the-chat-agent" },
      { title: "Backups", anchor: "backups" },
      { title: "Backups", anchor: "backups-1" },
    ]);
  });
});

describe("the help's chosen links", () => {
  const markdownOf = new Map(
    Object.entries(files).map(([path, markdown]) => {
      const name = path.split("/").at(-1)?.replace(/\.md$/, "") ?? "";
      return [path.includes("/reference/") ? `reference-${name}` : name, markdown];
    }),
  );
  const anchors = (markdown: string) => [...markdown.matchAll(/^#{1,6} (.+?)\s*#*\s*$/gm)].map((m) => slug(plain(m[1] ?? "")));

  it("each go to a guide the console serves, and to a heading it has", () => {
    const links = [
      ...START_HERE.map((s): { guide: string; section?: string } => ({ guide: s.guide })),
      ...POPULAR,
      ...TASKS.flatMap((t) => t.questions),
      ...IN_DEPTH,
      ...Object.values(SYMPTOMS).flatMap((s) => s.items),
    ];
    for (const { guide, section } of links) {
      if (guide === API_REFERENCE_ID) continue;
      const markdown = markdownOf.get(guide);
      expect(markdown, guide).toBeDefined();
      if (section) expect(anchors(markdown ?? ""), `${guide}#${section}`).toContain(section);
    }
  });
});
