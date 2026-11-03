// SPDX-License-Identifier: MIT
/**
 * GitHub's pages for a file in the catalog repository: one to create it,
 * filled in (GitHub then offers to commit it on a new branch and open the
 * pull request), or one to edit it. On main, where the catalog releases
 * from, as the console's own links into it (../../src/core/catalogLinks.ts).
 */
const BRANCH = "main";

/** `repo` is owner/name, or its https://github.com/ address. */
export function catalogFileUrl(repo: string, path: string, mode: "new" | "edit", value = ""): string {
  const base = repo.startsWith("https://") ? repo : `https://github.com/${repo}`;
  if (mode === "edit") return `${base}/edit/${BRANCH}/${path}`;
  return `${base}/new/${BRANCH}?${new URLSearchParams({ filename: path, value }).toString()}`;
}
