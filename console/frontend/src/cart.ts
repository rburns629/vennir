// SPDX-License-Identifier: MIT
import { useEffect, useState, useSyncExternalStore } from "react";
import { ApiError, cloudList, previewOrder, type OrderOption, type OrderProblem, type OrderSuggestion, type Runnable } from "./api";
import type { Check } from "./components/CheckStrip";
import type { BuiltStep } from "./compose";

/**
 * The cart (decision 25): actions a person collects in the Catalog, then
 * orders together for one team (CartPage). Kept in this browser only, a
 * convenience: nothing about it is the server's until it's placed, so an
 * empty or unreadable store just means an empty cart.
 */
export interface Cart {
  /** The team it's for; null until chosen. */
  team: string | null;
  /** Registered actions (<team>-<product>-<action>); one may be in it twice. */
  actions: string[];
  /** Choices and values a chat answer filled in (by step, then input), for the cart page to start from. */
  choices: OrderOption[];
  values: Record<string, Record<string, unknown>>;
}

const KEY = "vertra.cart";
const EMPTY: Cart = { team: null, actions: [], choices: [], values: {} };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const listeners = new Set<() => void>();

function read(): Cart {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const { team, actions, choices, values } = parsed as Record<string, unknown>;
    return {
      team: typeof team === "string" ? team : null,
      actions: Array.isArray(actions) ? actions.filter((a): a is string => typeof a === "string").slice(0, 50) : [],
      choices: Array.isArray(choices) ? choices.filter((c): c is OrderOption => isRecord(c) && typeof c["step"] === "string" && typeof c["input"] === "string") : [],
      values: isRecord(values) ? Object.fromEntries(Object.entries(values).filter((e): e is [string, Record<string, unknown>] => isRecord(e[1]))) : {},
    };
  } catch {
    return EMPTY;
  }
}

let current = read();

function write(next: Cart): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not kept (a private window): it still works on this page.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab's change.
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) {
      current = read();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useCart(): Cart {
  return useSyncExternalStore(subscribe, () => current);
}

// A changed cart's steps (or team) may not be the ones a chat answer's
// choices and values were for: they're dropped.
export const cart = {
  add(action: string): void {
    if (current.actions.length < 50) write({ ...current, actions: [...current.actions, action], choices: [], values: {} });
  },
  removeAt(index: number): void {
    write({ ...current, actions: current.actions.filter((_, i) => i !== index), choices: [], values: {} });
  },
  setTeam(team: string): void {
    write({ ...current, team, choices: [], values: {} });
  },
  /** What a chat answer proposed, in place of what's there. */
  replace(team: string, actions: string[], choices: OrderOption[] = [], values: Cart["values"] = {}): void {
    write({ team, actions: actions.slice(0, 50), choices, values });
  },
  clear(): void {
    write({ team: current.team, actions: [], choices: [], values: {} });
  },
};

/** A cart planned for a team (OrderService/PreviewOrder): its steps wired, what it couldn't settle, what's suggested. */
export interface Plan {
  steps: BuiltStep[];
  problems: OrderProblem[];
  suggestions: OrderSuggestion[];
}

/** The plan for these actions, for this team with these choices: planned again whenever one changes. Runs nothing. */
export function useOrderPlan(team: string | null, actions: string[], choices: OrderOption[]): { plan: Plan | null; error: string | null } {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!team || actions.length === 0) {
      setPlan(null);
      setError(null);
      return;
    }
    let current = true;
    previewOrder(team, actions, choices)
      .then((p) => {
        if (current) {
          setPlan(p);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!current) return;
        // The last plan was for other choices (another team, say): it isn't this order's.
        setPlan(null);
        setError(err instanceof ApiError ? err.message : "Couldn't plan the order.");
      });
    return () => {
      current = false;
    };
  }, [team, actions, choices]);
  return { plan, error };
}

/**
 * A plan's account, for a strip of checks: how many steps and in what
 * order, what was added, choices made and left, and steps that are for
 * other installs, aren't ready here or are deprecated (by `action`, the step's action as the
 * catalog lists it).
 */
export function planChecks(plan: Plan, choices: OrderOption[], action: (product: string) => Runnable | undefined, install: string): Check[] {
  const name = (product: string) => action(product)?.displayName || product;
  const checks: Check[] = [];
  const cycle = plan.problems.find((p) => p.code === "CYCLE");
  if (cycle) checks.push({ tone: "error", text: cycle.message });
  else checks.push({ tone: "success", text: `${String(plan.steps.length)} ${plan.steps.length === 1 ? "step" : "steps"}, in the order they can run` });
  const chosen = choices.length;
  const added = plan.steps.filter((s) => s.added);
  if (added.length > 0) checks.push({ tone: "info", text: `Adds ${added.map((s) => name(s.product)).join(", ")}: something in your cart needs ${added.length === 1 ? "it" : "them"}` });
  if (chosen > 0) checks.push({ tone: "success", text: `${String(chosen)} ${chosen === 1 ? "choice" : "choices"} made` });
  const open = plan.problems.filter((p) => p.options.length > 0 && !choices.some((c) => c.step === p.step && c.input === p.input));
  if (open.length > 0)
    checks.push({
      tone: "warning",
      text: `${String(open.length)} ${open.length === 1 ? "choice" : "choices"}: what fills ${open.map((p) => `${name(plan.steps.find((s) => s.id === p.step)?.product ?? p.step)}'s ${p.input}`).join(", ")}`,
    });
  const notHere = plan.steps.filter((s) => action(s.product)?.runsHere === false);
  if (notHere.length > 0) {
    const clouds = [...new Set(notHere.flatMap((s) => action(s.product)?.clouds ?? []))].sort();
    checks.push({ tone: "error", text: `${String(notHere.length)} ${notHere.length === 1 ? "step" : "steps"} for ${cloudList(clouds)} installs: can't run on ${install}` });
  }
  const unready = plan.steps.filter((s) => action(s.product)?.readiness?.state === "not_ready").length;
  if (unready > 0) checks.push({ tone: "warning", text: `${String(unready)} ${unready === 1 ? "step" : "steps"} not ready on ${install}` });
  const deprecated = plan.steps.filter((s) => action(s.product)?.deprecated).length;
  if (deprecated > 0) checks.push({ tone: "warning", text: `${String(deprecated)} ${deprecated === 1 ? "step" : "steps"} deprecated` });
  return checks;
}
