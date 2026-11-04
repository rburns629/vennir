// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorMessage, deleteDraft, listDrafts, saveDraft, type StoredDraft } from "../api";
import type { Draft } from "../compose";

/** Where drafts were kept before the console kept them. */
const BROWSER_KEY = "vennir.compose.drafts";
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SAVE_AFTER_MS = 1000;

const keyOf = (d: { team: string; name: string }) => `${d.team}/${d.name}`;

/** A stored body as a Draft: what the page saved, with anything missing filled in. */
export function draftOf(stored: StoredDraft): Draft {
  const body = stored.body as Partial<Draft>;
  return {
    name: stored.name,
    team: stored.team,
    displayName: typeof body.displayName === "string" ? body.displayName : "",
    description: typeof body.description === "string" ? body.description : "",
    steps: Array.isArray(body.steps) ? body.steps : [],
  };
}

function browserDrafts(): Draft[] {
  try {
    const raw = localStorage.getItem(BROWSER_KEY);
    return raw ? Object.values(JSON.parse(raw) as Record<string, Draft>) : [];
  } catch {
    return [];
  }
}

/** Forgets the drafts this browser kept, when its person's session ends: they're theirs, not the next person's. */
export function forgetBrowserDrafts(): void {
  try {
    localStorage.removeItem(BROWSER_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

export type SaveStatus = "idle" | "saving" | "saved" | "conflict" | "error";

/**
 * Compose's drafts, kept by the console for each one's team: the list,
 * and the open draft saved a second after its last change. Saves go one at
 * a time, each naming the version the last returned; one someone else beat
 * is a conflict, which keepMine or the page's reload settles. Renaming the
 * open draft moves it. `edited` marks a change to save; opening one doesn't.
 * Only the draft this page opened or saved is saved over: a new one, or a
 * rename onto a name that's taken, is created, so someone else's draft by
 * that name is a conflict, never replaced (unless keepMine says so).
 */
export function useComposeDrafts(current: Draft) {
  const [drafts, setDrafts] = useState<StoredDraft[] | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [inBrowser, setInBrowser] = useState<Draft[]>(browserDrafts);
  const versions = useRef(new Map<string, number>());
  // The open draft's key as last saved (null: never), so a rename moves it.
  const savedAs = useRef<string | null>(null);
  // Changes made, and how many of them are saved.
  const edits = useRef(0);
  const savedEdits = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const reload = useCallback(async (): Promise<StoredDraft[]> => {
    const all = await listDrafts();
    versions.current = new Map(all.map((d) => [keyOf(d), d.version]));
    setDrafts(all);
    return all;
  }, []);

  useEffect(() => {
    reload().catch((err: unknown) => {
      setProblem(errorMessage(err, "Couldn't load the drafts."));
    });
  }, [reload]);

  const save = useCallback((draft: Draft, overwrite = false) => {
    const key = keyOf(draft);
    const upTo = edits.current;
    queue.current = queue.current.then(async () => {
      setStatus("saving");
      try {
        const ours = overwrite || savedAs.current === key;
        const saved = await saveDraft({ team: draft.team, name: draft.name, body: { ...draft }, version: ours ? (versions.current.get(key) ?? 0) : 0 });
        versions.current.set(key, saved.version);
        savedEdits.current = Math.max(savedEdits.current, upTo);
        const moved = savedAs.current !== null && savedAs.current !== key ? savedAs.current : null;
        savedAs.current = key;
        if (moved) {
          const [team = "", name = ""] = moved.split("/");
          await deleteDraft(team, name);
          versions.current.delete(moved);
        }
        setDrafts((list) => [saved, ...(list ?? []).filter((d) => keyOf(d) !== key && keyOf(d) !== moved)]);
        setStatus("saved");
        setProblem(null);
      } catch (err) {
        if (err instanceof ApiError && err.code === "DRAFT_CHANGED") {
          setStatus("conflict");
          setProblem(err.message);
          const theirs = err.detail?.["version"];
          if (typeof theirs === "number") versions.current.set(key, theirs);
        } else {
          setStatus("error");
          setProblem(errorMessage(err, "Couldn't save the draft."));
        }
      }
    });
  }, []);

  // Saved a second after its last change, once it has a team and a name its file could have.
  useEffect(() => {
    if (edits.current === savedEdits.current || status === "conflict" || !current.team || !NAME.test(current.name)) return;
    const timer = setTimeout(() => { save(current); }, SAVE_AFTER_MS);
    return () => { clearTimeout(timer); };
    // status: a conflict stops saving until it's settled.
  }, [current, save, status]);

  return {
    drafts,
    status,
    problem,
    inBrowser,
    reload,
    /** Marks a change to the open draft, to save. */
    edited: () => { edits.current += 1; },
    /** Opens a draft: nothing to save until it changes. */
    opened: (d: Draft | null) => {
      edits.current = 0;
      savedEdits.current = 0;
      savedAs.current = d ? keyOf(d) : null;
      setStatus("idle");
      setProblem(null);
    },
    /** Saves the open draft over whatever someone else saved. */
    keepMine: () => { save(current, true); },
    remove: async (d: StoredDraft) => {
      await deleteDraft(d.team, d.name);
      versions.current.delete(keyOf(d));
      if (savedAs.current === keyOf(d)) savedAs.current = null;
      setDrafts((list) => (list ?? []).filter((x) => keyOf(x) !== keyOf(d)));
    },
    /** Moves the drafts this browser kept into the console: how many moved (one whose name is taken stays). */
    moveFromBrowser: async (teams: string[]): Promise<number> => {
      let moved = 0;
      const left: Draft[] = [];
      for (const d of inBrowser) {
        if (!teams.includes(d.team) || !NAME.test(d.name)) {
          left.push(d);
          continue;
        }
        try {
          await saveDraft({ team: d.team, name: d.name, body: { ...d }, version: 0 });
          moved += 1;
        } catch {
          left.push(d);
        }
      }
      try {
        if (left.length === 0) localStorage.removeItem(BROWSER_KEY);
        else localStorage.setItem(BROWSER_KEY, JSON.stringify(Object.fromEntries(left.map((d) => [d.name, d]))));
      } catch {
        // A browser that won't change it: they're offered again next time.
      }
      setInBrowser(left);
      await reload();
      return moved;
    },
  };
}
