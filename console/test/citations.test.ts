// SPDX-License-Identifier: MIT
/**
 * The chat agent's citations (src/chat/citations.ts): kept only when they
 * name a section retrieved that turn, linked by the console itself, and an
 * answer citing nothing it found flagged.
 */
import { describe, expect, it } from "vitest";
import { anchor, asSources, checkCitations } from "../src/chat/citations.js";
import type { Hit } from "../src/guideSearch.js";

const hit = (guide: string, heading: string, kind: Hit["kind"] = "current"): Hit => ({ guide, title: "Operations", heading, kind, excerpt: "", score: 1 });

describe("citations", () => {
  const sources = asSources([hit("reference-operations", "Backups"), hit("reference-operations", "Databases > Upgrading Postgres", "operating")], 0);

  it("keeps what was retrieved, linked by the console, and drops what wasn't", () => {
    const checked = checkCitations("Back up both databases nightly [S1]. Restore with pg_restore [S9]. Upgrade in place [S2, S7].", sources);
    expect(checked.text).toBe("Back up both databases nightly [S1]. Restore with pg_restore. Upgrade in place [S2].");
    expect(checked.invented).toEqual(["S9", "S7"]);
    expect(checked.citations).toEqual([
      { id: "S1", guide: "reference-operations", title: "Operations", heading: "Backups", kind: "current", link: "/docs/reference-operations#backups" },
      { id: "S2", guide: "reference-operations", title: "Operations", heading: "Databases > Upgrading Postgres", kind: "operating", link: "/docs/reference-operations#upgrading-postgres" },
    ]);
    expect(checked.uncited).toBe(false);
  });

  it("flags an answer that searched the docs and cites nothing it found", () => {
    expect(checkCitations("Back up nightly.", sources).uncited).toBe(true);
    expect(checkCitations("Back up nightly [S4].", sources)).toMatchObject({ uncited: true, invented: ["S4"] });
    // Nothing searched: nothing to cite (an answer from the tools' data).
    expect(checkCitations("You have two projects.", []).uncited).toBe(false);
  });

  it("numbers each turn's sources after the last", () => {
    expect(asSources([hit("a", "x")], 2).map((s) => s.id)).toEqual(["S3"]);
  });

  it("makes anchors as the Docs page does", () => {
    expect(anchor("Upgrading `vennir-system` (Helm 4)!")).toBe("upgrading-vennir-system-helm-4");
  });
});
