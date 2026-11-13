#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""What a change touches beyond its own files (.github/impact.toml).

    make impact                         # this branch against origin/main,
                                        # uncommitted changes to tracked files too
    python3 .github/scripts/impact.py --base A --head B   # a pull request (CI)
    python3 .github/scripts/impact.py --check-map         # only the map's paths

Reports, for the changed files:
  - each rule in impact.toml a change touches, and the files on its other
    side that didn't change: a failure until they do, or a commit in the
    range says it looked (`Impact-checked: <rule id>: <why>`), unless the
    rule names a test that already fails while they disagree (`checked`);
  - files added, moved or removed without a line in docs/repository-map.md
    (rule id "repository-map");
  - what imports each changed source file (TypeScript and Go), to start a
    pull request's "Affects" table from. Only reported.
And fails when a path in impact.toml matches no file, so the map can't go
stale. Standard library only.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

MAP = ".github/impact.toml"
REPOSITORY_MAP = "docs/repository-map.md"
TRAILER = re.compile(r"^impact-checked:\s*([A-Za-z0-9_-]+)\s*:\s*(\S.*)$", re.IGNORECASE | re.MULTILINE)
MAX_LISTED = 15


def glob_re(pattern: str) -> re.Pattern[str]:
    """A path glob as a regular expression: * within a folder, ** across."""
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif pattern[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out + r"\Z")


def matching(paths, pattern: str) -> list[str]:
    rx = glob_re(pattern)
    return sorted(p for p in paths if rx.match(p))


@dataclass
class Finding:
    rule: str
    why: str
    changed: list[str]
    missing: list[str]
    checked: str = ""
    acknowledged: str = ""

    @property
    def fails(self) -> bool:
        return bool(self.missing) and not self.checked and not self.acknowledged


@dataclass
class Changes:
    """Changed paths by status: A added, D deleted, M modified (a rename is
    its old path deleted and its new one added)."""

    status: dict[str, str] = field(default_factory=dict)

    @property
    def paths(self) -> set[str]:
        return set(self.status)


def evaluate(rules: list[dict], ignore: list[str], changes: Changes, acks: dict[str, str]) -> list[Finding]:
    """Every rule the changes touch, with what's missing on its other side."""
    findings = []
    changed = changes.paths
    for rule in rules:
        if "files" in rule:
            members = rule["files"]
            touched = [m for m in members if matching(changed, m)]
            if not touched:
                continue
            missing = [m for m in members if m not in touched]
            hits = sorted({p for m in touched for p in matching(changed, m)})
        else:
            hits = sorted({p for w in rule["when"] for p in matching(changed, w)})
            if not hits:
                continue
            missing = [t for t in rule["then"] if not matching(changed, t)]
        findings.append(Finding(rule["id"], rule["why"], hits, missing, rule.get("checked", ""), acks.get(rule["id"], "")))
    moved = sorted(
        p for p, s in changes.status.items()
        if s in ("A", "D") and p != REPOSITORY_MAP and not any(glob_re(g).match(p) for g in ignore)
    )
    if moved:
        missing = [] if REPOSITORY_MAP in changed else [REPOSITORY_MAP]
        findings.append(Finding("repository-map", "A file added, moved or removed needs its line in docs/repository-map.md.",
                                moved, missing, "", acks.get("repository-map", "")))
    return findings


def map_problems(rules: list[dict], tracked: set[str]) -> list[str]:
    """Rules that are malformed, or name a path matching no file."""
    problems, ids = [], set()
    for rule in rules:
        rid = rule.get("id", "?")
        if rid in ids:
            problems.append(f"{rid}: the id is used twice")
        ids.add(rid)
        if not rule.get("why"):
            problems.append(f"{rid}: no why")
        if ("files" in rule) == ("when" in rule or "then" in rule) or ("when" in rule) != ("then" in rule):
            problems.append(f"{rid}: give either files, or when and then")
            continue
        globs = rule.get("files", []) + rule.get("when", []) + rule.get("then", [])
        if "files" in rule and len(rule["files"]) < 2:
            problems.append(f"{rid}: files needs at least two entries")
        for g in globs:
            if not matching(tracked, g):
                problems.append(f"{rid}: {g} matches no file (moved or renamed? update {MAP})")
    return problems


def acknowledgements(messages: str) -> dict[str, str]:
    return {m.group(1).lower(): m.group(2).strip() for m in TRAILER.finditer(messages)}


# --- Dependents: what imports a changed file -------------------------------

TS_IMPORT = re.compile(r"""(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}/[^"']+)["']""")
GO_IMPORT = re.compile(r'"([^"\s]+)"')
TS_ROOTS = ("console/src", "console/test", "console/scripts", "console/frontend/src")


def ts_target(importer: str, spec: str, files: set[str]) -> str | None:
    base = os.path.normpath(os.path.join(os.path.dirname(importer), spec))
    stem = re.sub(r"\.(js|jsx|ts|tsx|mjs)$", "", base)
    for candidate in (base, stem + ".ts", stem + ".tsx", stem + "/index.ts", stem + "/index.tsx"):
        if candidate in files:
            return candidate
    return None


def ts_dependents(root: Path, tracked: set[str]) -> dict[str, set[str]]:
    files = {p for p in tracked if p.startswith(TS_ROOTS) and p.endswith((".ts", ".tsx")) and "/gen/" not in p}
    reverse: dict[str, set[str]] = {}
    for f in files:
        try:
            text = (root / f).read_text(encoding="utf-8")
        except OSError:
            continue
        for spec in TS_IMPORT.findall(text):
            target = ts_target(f, spec, files)
            if target and target != f:
                reverse.setdefault(target, set()).add(f)
    return reverse


def go_dependents(root: Path, tracked: set[str]) -> tuple[dict[str, set[str]], dict[str, str]]:
    """Importers of each Go package (by import path), and each Go file's package."""
    modules = {}
    for gomod in (p for p in tracked if p.endswith("go.mod")):
        line = next((l for l in (root / gomod).read_text().splitlines() if l.startswith("module ")), "")
        if line:
            modules[os.path.dirname(gomod)] = line.split()[1]
    package_of, reverse = {}, {}
    for f in (p for p in tracked if p.endswith(".go") and "/gen/" not in p):
        mod_dir = max((d for d in modules if f.startswith(d + "/")), key=len, default=None)
        if mod_dir is None:
            continue
        rel = os.path.dirname(f)[len(mod_dir) + 1:]
        package_of[f] = modules[mod_dir] + ("/" + rel if rel else "")
        try:
            text = (root / f).read_text(encoding="utf-8")
        except OSError:
            continue
        head = text.split("\n)\n", 1)[0] if "import (" in text else "\n".join(l for l in text.splitlines() if l.startswith("import "))
        for imp in GO_IMPORT.findall(head):
            if imp.startswith(modules[mod_dir]):
                reverse.setdefault(imp, set()).add(f)
    return reverse, package_of


def is_test(path: str) -> bool:
    return path.endswith(("_test.go", ".test.ts", ".test.tsx")) or "/test/" in path


def dependents(root: Path, tracked: set[str], changed: list[str]) -> dict[str, list[str]]:
    ts = ts_dependents(root, tracked)
    go, package_of = go_dependents(root, tracked)
    out = {}
    for f in changed:
        if is_test(f):
            continue
        users = set(ts.get(f, set()))
        if f in package_of:
            users |= go.get(package_of[f], set())
        if users:
            out[f] = sorted(users)
    return out


# --- Git and output --------------------------------------------------------

def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def read_changes(base: str, head: str, worktree: bool) -> Changes:
    changes = Changes()

    def add(lines: str) -> None:
        for line in lines.splitlines():
            parts = line.split("\t")
            code = parts[0][:1]
            if code == "R" and len(parts) == 3:
                changes.status[parts[1]] = "D"
                changes.status[parts[2]] = "A"
            elif code in ("A", "D") and len(parts) == 2:
                changes.status[parts[1]] = code
            elif len(parts) >= 2:
                changes.status.setdefault(parts[-1], "M")

    add(git("diff", "--name-status", "-M", f"{base}...{head}"))
    if worktree:
        # Tracked files only (staged or not): a new file counts once `git add`ed.
        add(git("diff", "--name-status", "-M", "HEAD"))
    return changes


def report(findings: list[Finding], deps: dict[str, list[str]], problems: list[str]) -> str:
    lines = ["## Change impact", ""]
    if problems:
        lines += ["**The map (.github/impact.toml) is out of date:**", ""] + [f"- {p}" for p in problems] + [""]
    failing = [f for f in findings if f.fails]
    if not findings:
        lines += ["No coupled files touched.", ""]
    for f in findings:
        if not f.missing:
            state = "both sides changed"
        elif f.checked:
            state = f"other side unchanged; checked by {f.checked}"
        elif f.acknowledged:
            state = f"other side unchanged; looked at: {f.acknowledged}"
        else:
            state = "**other side unchanged: look at it**"
        lines.append(f"- **{f.rule}**: {state}")
        lines.append(f"  - why: {f.why}")
        lines.append(f"  - changed: {', '.join(f.changed[:MAX_LISTED])}{' …' if len(f.changed) > MAX_LISTED else ''}")
        if f.missing:
            lines.append(f"  - not changed: {', '.join(f.missing)}")
    if failing:
        lines += ["", "To pass, change the other side, or add a trailer to a commit saying why it needs no change:", ""]
        lines += [f"    Impact-checked: {f.rule}: <why it needs no change>" for f in failing]
    if deps:
        lines += ["", "### What imports the changed files", "", "Start the pull request's Affects table from these:", ""]
        def listed(paths: list[str]) -> str:
            more = f" and {len(paths) - MAX_LISTED} more" if len(paths) > MAX_LISTED else ""
            return ", ".join(paths[:MAX_LISTED]) + more

        for f, users in sorted(deps.items()):
            code = [u for u in users if not is_test(u)]
            tests = [u for u in users if is_test(u)]
            lines.append(f"- `{f}`: {listed(code) if code else 'no code'}")
            if tests:
                lines.append(f"  - tests: {listed(tests)}")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", help="compare against (default: where this branch left origin/main)")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--check-map", action="store_true", help="only check the map's paths")
    args = parser.parse_args()

    root = Path(git("rev-parse", "--show-toplevel").strip())
    os.chdir(root)
    config = tomllib.loads((root / MAP).read_text())
    rules = config.get("rule", [])
    ignore = config.get("repository-map", {}).get("ignore", [])
    tracked = set(git("ls-files").splitlines())
    problems = map_problems(rules, tracked)
    if args.check_map:
        print("\n".join(problems) if problems else f"{MAP}: every path matches a file.")
        return 1 if problems else 0

    worktree = args.base is None
    base = args.base or git("merge-base", "origin/main", args.head).strip()
    changes = read_changes(base, args.head, worktree)
    acks = acknowledgements(git("log", "--format=%B", f"{base}..{args.head}"))
    findings = evaluate(rules, ignore, changes, acks)
    deps = dependents(root, tracked, sorted(p for p, s in changes.status.items() if s != "D"))
    text = report(findings, deps, problems)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as out:
            out.write(text)
    return 1 if problems or any(f.fails for f in findings) else 0


if __name__ == "__main__":
    sys.exit(main())
