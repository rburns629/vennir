// SPDX-License-Identifier: MIT
/**
 * Live checking for the Submit page's DAG editor: parses what's been pasted
 * (JSON or YAML) and reports, as specifically as it can, why it wouldn't be
 * accepted -- so the editor can go green or red as you type and Submit only
 * enables for something that will actually go through.
 *
 * Mirrors the real rules rather than inventing its own, so green means
 * accepted:
 *   - the kernel's submission contract (proto/vennir/kernel/v1 and
 *     kernel/internal/api/service.go: required fields, number ranges; the
 *     console's client refuses unknown fields) and its DAG checks
 *     (kernel/internal/domain/dag.go: duplicate ids,
 *     self/unknown dependencies, $fromTask references, cycles);
 *   - the console's own (team membership in ../../src/core/executions.ts,
 *     allowed image sources in ../../src/imagePolicy.ts).
 * The server still decides; if these drift, the worst case is a refusal
 * with the server's message after Submit, not a wrong run.
 */
import { load as parseYaml, YAMLException } from "js-yaml";

export interface DagIssue {
  /** Where, in words: "Task "deploy" (tasks[1]).image", "Line 4, column 3". */
  where?: string;
  message: string;
}

export type DagCheck =
  | { status: "empty" }
  | {
      status: "invalid";
      issues: DagIssue[];
      /** Set when the only problem is stray whitespace in identifier fields:
       * the corrected text, in the same format it was written in. */
      whitespaceFix?: { text: string; paths: string[] };
    }
  | {
      status: "valid";
      payload: Record<string, unknown>;
      format: "JSON" | "YAML";
      taskCount: number;
      /** Tasks grouped by when they can run: each stage only depends on earlier ones. */
      stages: string[][];
    };

export interface DagCheckContext {
  /** Allowed image sources; null while unknown (not checked then). */
  allowedSources: string[] | null;
  /** The teams the user may submit for; null means any (an admin). */
  teamNames: string[] | null;
}

const TOP_LEVEL_FIELDS = ["apiVersion", "kind", "name", "requestId", "tasks"];
/** The catalog format a dags/ file says it's in (apiVersion: …, kind: Dag). */
const CATALOG_API_VERSION = "vennir.dev/v2";
// Renamed: a DAG written with these is told the new name.
const OLD_FIELD_NAMES: Record<string, string> = { externalReference: "name", idempotencyKey: "requestId" };
const TASK_FIELDS = [
  "id",
  "image",
  "action",
  "team",
  "serviceAccount",
  "dependsOn",
  "inputs",
  "secretRefs",
  "timeoutSeconds",
  "maxAttempts",
];
const REQUIRED_TASK_STRINGS = ["id", "image", "action", "team"] as const;
/** Left out, the console fills it in: the product's own, or "default". */
const OPTIONAL_TASK_STRINGS = ["serviceAccount"] as const;
/** Identifiers that can never legitimately contain whitespace. A stray
 * space (a real demo-breaking bug: "product: sha" from a careless tag
 * substitution) is still valid JSON/YAML, so it would otherwise only
 * surface minutes later as a Kubernetes InvalidImageName. `inputs` is left
 * alone: it's product-defined data. */
const WHITESPACE_FREE_FIELDS = ["id", "image", "action", "team", "serviceAccount"] as const;

type Parsed = { value: unknown; format: "JSON" | "YAML" } | { error: DagIssue };

/** JSON when it parses as JSON; YAML otherwise. A text that *looks* like
 * JSON (starts with { or [) gets the JSON error, since that's what was
 * meant; anything else gets YAML's, with its line and column. */
function parse(text: string): Parsed {
  try {
    return { value: JSON.parse(text) as unknown, format: "JSON" };
  } catch (jsonError) {
    const looksLikeJson = /^\s*[[{]/.test(text);
    try {
      const value = parseYaml(text);
      return { value, format: looksLikeJson ? "JSON" : "YAML" };
    } catch (yamlError) {
      if (looksLikeJson) {
        const message = jsonError instanceof Error ? jsonError.message : String(jsonError);
        const position = /line (\d+) column (\d+)/.exec(message);
        return {
          error: {
            where: position ? `Line ${position[1] ?? ""}, column ${position[2] ?? ""}` : undefined,
            message: `Not valid JSON: ${message.replace(/\s*\(line \d+ column \d+\)/, "").replace(/\s*in JSON at position \d+/, "")}`,
          },
        };
      }
      if (yamlError instanceof YAMLException) {
        const mark = yamlError.mark as { line: number; column: number } | undefined;
        return {
          error: {
            where: mark ? `Line ${String(mark.line + 1)}, column ${String(mark.column + 1)}` : undefined,
            message: `Not valid YAML: ${yamlError.reason}`,
          },
        };
      }
      return { error: { message: `Couldn't parse this as JSON or YAML: ${String(yamlError)}` } };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The closest allowed name, for "did you mean". Case-insensitive match
 * first (dependson), then one or two typos (dependOn, teams). */
function suggest(name: string, allowed: string[]): string | null {
  const lower = name.toLowerCase();
  const sameCase = allowed.find((a) => a.toLowerCase() === lower);
  if (sameCase) return sameCase;
  let best: { name: string; distance: number } | null = null;
  for (const candidate of allowed) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) best = { name: candidate, distance };
  }
  return best?.name ?? null;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] ?? 0;
      row[j] = Math.min(current + 1, (row[j - 1] ?? 0) + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length] ?? 0;
}

function unknownFieldIssue(where: string, field: string, allowed: string[]): DagIssue {
  const guess = suggest(field, allowed);
  return {
    where,
    message: `Unknown field "${field}".${guess ? ` Did you mean "${guess}"?` : ""} Allowed: ${allowed.join(", ")}.`,
  };
}

/** Same reading as the kubelet's (and ../../src/imagePolicy.ts's). */
function normalizeImage(image: string): string {
  const first = image.split("/")[0] ?? "";
  const hasHost = image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  if (hasHost) return image;
  return image.includes("/") ? `docker.io/${image}` : `docker.io/library/${image}`;
}

/** `{"$fromTask": …, "$output": …}` markers anywhere in a task's inputs. */
function inputReferences(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) inputReferences(item, found);
  } else if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 2 && keys.includes("$fromTask") && keys.includes("$output")) {
      if (typeof value["$fromTask"] === "string") found.push(value["$fromTask"]);
    } else {
      for (const item of Object.values(value)) inputReferences(item, found);
    }
  }
  return found;
}

/** Stages for a valid graph, or the tasks caught in a cycle. */
function stagesOf(tasks: { id: string; dependsOn: string[] }[]): { stages: string[][] } | { cycle: string[] } {
  const remaining = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn)]));
  const stages: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) return { cycle: [...remaining.keys()] };
    stages.push(ready);
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
  }
  return { stages };
}

function stripWhitespace(payload: Record<string, unknown>): { fixed: Record<string, unknown>; paths: string[] } {
  const paths: string[] = [];
  const strip = (value: unknown, path: string): unknown => {
    if (typeof value !== "string" || !/\s/.test(value)) return value;
    paths.push(path);
    return value.replace(/\s+/g, "");
  };
  const tasks = Array.isArray(payload["tasks"])
    ? payload["tasks"].map((task, i) => {
        if (!isRecord(task)) return task;
        const t: Record<string, unknown> = { ...task };
        for (const field of WHITESPACE_FREE_FIELDS) t[field] = strip(t[field], `tasks[${String(i)}].${field}`);
        for (const list of ["dependsOn", "secretRefs"]) {
          const entries = t[list];
          if (Array.isArray(entries)) t[list] = entries.map((e, j) => strip(e, `tasks[${String(i)}].${list}[${String(j)}]`));
        }
        return t;
      })
    : payload["tasks"];
  return { fixed: { ...payload, tasks }, paths };
}

export function checkDag(text: string, context: DagCheckContext, dump: (value: unknown) => string): DagCheck {
  if (text.trim() === "") return { status: "empty" };

  const parsed = parse(text);
  if ("error" in parsed) return { status: "invalid", issues: [parsed.error] };
  const { value, format } = parsed;
  if (!isRecord(value)) {
    const what = Array.isArray(value) ? "a list" : typeof value === "string" ? "plain text" : `a ${typeof value}`;
    return {
      status: "invalid",
      issues: [{ message: `This reads as ${what}, not a DAG. Expected an object with a name and tasks.` }],
    };
  }

  // A catalog's dags/ files carry their format (apiVersion, kind). A Dag
  // is submitted as it is; a Template names actions and parameters, which
  // the console can't run from here.
  if (value["kind"] === "Template") {
    return {
      status: "invalid",
      issues: [
        {
          where: "kind",
          message:
            "This is a template (kind: Template): its steps name actions, not images, and it needs its parameters filled in. Paste a DAG (kind: Dag) here.",
        },
      ],
    };
  }
  const header: DagIssue[] = [];
  if (value["kind"] !== undefined && value["kind"] !== "Dag") {
    header.push({ where: "kind", message: `Only a DAG (kind: Dag) can be submitted, not kind ${JSON.stringify(value["kind"])}.` });
  }
  if (value["apiVersion"] !== undefined && value["apiVersion"] !== CATALOG_API_VERSION) {
    header.push({ where: "apiVersion", message: `This console reads ${CATALOG_API_VERSION}.` });
  }
  if (header.length > 0) return { status: "invalid", issues: header };

  // Whitespace first, with a one-click fix: it's the one mistake that's
  // always safe to correct automatically.
  const { fixed, paths } = stripWhitespace(value);
  if (paths.length > 0) {
    return {
      status: "invalid",
      issues: paths.map((path) => ({ where: path, message: "Contains whitespace, which an identifier or image can never have." })),
      whitespaceFix: { text: format === "JSON" ? JSON.stringify(fixed, null, 2) : dump(fixed), paths },
    };
  }

  const issues: DagIssue[] = [];
  for (const field of Object.keys(value)) {
    const current = OLD_FIELD_NAMES[field];
    if (current) {
      issues.push({ where: field, message: `Renamed to "${current}": use "${current}" instead.` });
    } else if (!TOP_LEVEL_FIELDS.includes(field)) {
      issues.push(unknownFieldIssue("Top level", field, TOP_LEVEL_FIELDS));
    }
  }
  const name = value["name"];
  if (typeof name !== "string" || name === "") {
    issues.push({ where: "name", message: "Required: a label for this run, e.g. my-first-hello. It can repeat." });
  }
  const requestId = value["requestId"];
  if (requestId !== undefined && (typeof requestId !== "string" || requestId === "")) {
    issues.push({
      where: "requestId",
      message: "Optional, but when given it must be a non-empty string. Leave it out to start a new run every time.",
    });
  }
  const rawTasks = value["tasks"];
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    issues.push({ where: "tasks", message: "Required, and must be a list with at least one task." });
    return { status: "invalid", issues };
  }

  const tasks: { id: string; dependsOn: string[]; label: string; refs: string[] }[] = [];
  const ids = new Set<string>();
  rawTasks.forEach((task, i) => {
    const index = `tasks[${String(i)}]`;
    if (!isRecord(task)) {
      issues.push({ where: index, message: "Each task must be an object." });
      return;
    }
    const id = typeof task["id"] === "string" && task["id"] ? task["id"] : null;
    const label = id ? `Task "${id}" (${index})` : index;
    for (const field of Object.keys(task)) {
      if (!TASK_FIELDS.includes(field)) issues.push(unknownFieldIssue(label, field, TASK_FIELDS));
    }
    for (const field of REQUIRED_TASK_STRINGS) {
      if (typeof task[field] !== "string" || task[field] === "") {
        issues.push({ where: `${label}.${field}`, message: "Required, and must be a non-empty string." });
      }
    }
    for (const field of OPTIONAL_TASK_STRINGS) {
      if (task[field] !== undefined && (typeof task[field] !== "string" || task[field] === "")) {
        issues.push({ where: `${label}.${field}`, message: "Must be a non-empty string, or left out." });
      }
    }
    for (const list of ["dependsOn", "secretRefs"]) {
      const entries = task[list];
      if (entries !== undefined && (!Array.isArray(entries) || entries.some((e) => typeof e !== "string" || e === ""))) {
        issues.push({ where: `${label}.${list}`, message: "Must be a list of non-empty strings." });
      }
    }
    if (task["inputs"] !== undefined && !isRecord(task["inputs"])) {
      issues.push({ where: `${label}.inputs`, message: "Must be an object (key: value pairs)." });
    }
    const timeout = task["timeoutSeconds"];
    if (timeout !== undefined && !(Number.isInteger(timeout) && (timeout as number) > 0)) {
      issues.push({ where: `${label}.timeoutSeconds`, message: "Must be a whole number of seconds, greater than 0." });
    }
    const attempts = task["maxAttempts"];
    if (attempts !== undefined && !(Number.isInteger(attempts) && (attempts as number) >= 1)) {
      issues.push({ where: `${label}.maxAttempts`, message: "Must be a whole number, at least 1." });
    }

    const team = task["team"];
    if (typeof team === "string" && team && context.teamNames && !context.teamNames.includes(team)) {
      issues.push({
        where: `${label}.team`,
        message: `You don't maintain team "${team}", so you can't submit a DAG for it.${
          context.teamNames.length > 0 ? ` You maintain: ${context.teamNames.join(", ")}.` : ""
        }`,
      });
    }
    const image = task["image"];
    if (typeof image === "string" && image && context.allowedSources) {
      if (context.allowedSources.length === 0) {
        issues.push({ where: `${label}.image`, message: "No image source is configured yet, so nothing can run. An admin sets it on the Admin page." });
      } else if (!context.allowedSources.some((source) => normalizeImage(image).startsWith(source))) {
        issues.push({
          where: `${label}.image`,
          message: `"${image}" isn't from an allowed image source. Allowed: ${context.allowedSources.join(", ")}.`,
        });
      }
    }

    if (id) {
      if (ids.has(id)) issues.push({ where: `${label}.id`, message: `Duplicate task id "${id}"; every task id must be unique.` });
      ids.add(id);
      const dependsOn = Array.isArray(task["dependsOn"]) ? task["dependsOn"].filter((d): d is string => typeof d === "string") : [];
      tasks.push({ id, dependsOn, label, refs: inputReferences(task["inputs"]) });
    }
  });

  let graphBroken = false;
  for (const task of tasks) {
    const repeated = [...new Set(task.dependsOn.filter((dep, i) => task.dependsOn.indexOf(dep) !== i))];
    for (const dep of repeated) {
      issues.push({ where: `${task.label}.dependsOn`, message: `Lists "${dep}" more than once.` });
    }
    for (const dep of task.dependsOn) {
      if (dep === task.id) {
        issues.push({ where: `${task.label}.dependsOn`, message: "A task can't depend on itself." });
        graphBroken = true;
      } else if (!ids.has(dep)) {
        const guess = suggest(dep, [...ids]);
        issues.push({
          where: `${task.label}.dependsOn`,
          message: `Depends on "${dep}", which isn't a task in this DAG.${guess ? ` Did you mean "${guess}"?` : ""}`,
        });
        graphBroken = true;
      }
    }
    for (const ref of task.refs) {
      if (!ids.has(ref)) {
        issues.push({ where: `${task.label}.inputs`, message: `Uses the output of "${ref}", which isn't a task in this DAG.` });
      } else if (!task.dependsOn.includes(ref)) {
        issues.push({
          where: `${task.label}.inputs`,
          message: `Uses the output of "${ref}" but doesn't list it in dependsOn, so it could run before "${ref}" finishes. Add "${ref}" to dependsOn.`,
        });
      }
    }
  }

  let stages: string[][] = [];
  if (!graphBroken && tasks.length === rawTasks.length) {
    const order = stagesOf(tasks);
    if ("cycle" in order) {
      issues.push({ where: "dependsOn", message: `These tasks depend on each other in a loop, so none can start: ${order.cycle.join(", ")}.` });
    } else {
      stages = order.stages;
    }
  }

  if (issues.length > 0) return { status: "invalid", issues };
  // The catalog file's header isn't part of the DAG the API takes.
  const { apiVersion: _apiVersion, kind: _kind, ...dag } = value;
  return { status: "valid", payload: dag, format, taskCount: rawTasks.length, stages };
}
