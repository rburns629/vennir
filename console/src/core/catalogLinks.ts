// SPDX-License-Identifier: MIT
/**
 * Links into the catalog repository for something the catalog defines (a
 * template, an action, an API): its file, and an issue asking its team to
 * share it. The console only reads the catalog: sharing changes there, in a
 * reviewed change, and reaches the install with the next release.
 */
import type { AuthUser } from "../auth/plugin.js";

/** https://github.com/<owner>/<repo> for a release's repository, or null for
 * anything that isn't on GitHub (only GitHub's pages are built today). */
export function githubBase(repository: string | null): string | null {
  const match = /^github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository ?? "");
  return match ? `https://github.com/${match[1] ?? ""}/${match[2] ?? ""}` : null;
}

/** Links for one template, action or API: where it's defined, and, when it isn't
 * shared with the caller, an issue asking its team to share it with theirs.
 * The person opens it in their own browser: the console only reads the
 * catalog (catalog releases come only from main). */
export function catalogLinks(
  base: string | null,
  path: string | null,
  what: string,
  ref: string,
  caller: AuthUser,
  shared: boolean,
): { sourceUrl: string | null; askForAccessUrl: string | null } {
  if (!base || !path) return { sourceUrl: null, askForAccessUrl: null };
  const sourceUrl = `${base}/blob/main/${path}`;
  if (shared) return { sourceUrl, askForAccessUrl: null };
  const asking = caller.teamNames.length > 0 ? caller.teamNames : ["<your team>"];
  const title = `Share ${ref} with ${asking.join(", ")}`;
  const body = [
    `Team ${asking.map((team) => `\`${team}\``).join(", ")} would like to use ${what} \`${ref}\`.`,
    "",
    `To share it, add the team to its \`shareWith\` in [\`${path}\`](${sourceUrl}), for example:`,
    "",
    "```yaml",
    `shareWith: [${asking.join(", ")}]`,
    "```",
    "",
    "Asked from the Vennir console.",
  ].join("\n");
  const query = new URLSearchParams({ title, body });
  return { sourceUrl, askForAccessUrl: `${base}/issues/new?${query.toString()}` };
}
