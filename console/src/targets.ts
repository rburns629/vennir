// SPDX-License-Identifier: MIT
/**
 * Allowed targets (X1): where another team may aim a team's products. An
 * action input typed (x-vennir-needs) as a kind of target names the
 * project, folder, account or subscription the owning team's identity acts
 * on; when another team runs it, the value must match one of the owning
 * team's rules for that team (team.yaml's allowedTargets, from the
 * catalog's release). The owning team's own runs, and admins', aren't
 * limited. A value an earlier step produces ($fromTask) isn't known when
 * the run is submitted: the input schema the console attaches for the kernel
 * is narrowed to what the rules allow (narrowWiredTargets), so the kernel
 * refuses any other value once it's resolved (INPUT_INVALID), before the
 * step starts. Since carts (decision 25) let anyone wire any provider in,
 * a step's say-so is no longer enough. The owning identity's cloud
 * permissions, scoped to the same folders, are the backstop; the console
 * never asks the cloud.
 */
import type { TargetRule } from "./db/schema.js";

/** The kinds of target, as team.yaml and x-vennir-needs name them. */
export const TARGET_TYPES = ["gcp.project", "gcp.folder", "aws.account", "azure.subscription"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An action's target inputs: input name to kind, from its input schema. */
export function targetInputs(inputSchema: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const properties = isRecord(inputSchema) && isRecord(inputSchema["properties"]) ? inputSchema["properties"] : {};
  for (const [name, property] of Object.entries(properties)) {
    const kind = isRecord(property) ? property["x-vennir-needs"] : undefined;
    if (typeof kind === "string" && (TARGET_TYPES as readonly string[]).includes(kind)) out.set(name, kind);
  }
  return out;
}

/** Whether a value matches a pattern: exact, where * matches any run of characters. */
export function matchesTarget(pattern: string, value: string): boolean {
  return new RegExp(schemaPattern(pattern)).test(value);
}

/** The values or patterns `teams` may supply for a kind of target, under the owner's rules. */
export function allowedValues(rules: TargetRule[], teams: string[], kind: string): string[] {
  return rules
    .filter((rule) => rule.teams.includes("*") || rule.teams.some((team) => teams.includes(team)))
    .flatMap((rule) => rule.targets[kind] ?? []);
}

/**
 * Whether these inputs aim the owner's product at a target that `teams` may
 * use only with an approval: one a rule asking for approval (approval: true)
 * allows, and no rule without one does. A value an earlier step produced
 * isn't checked, as in targetProblems.
 */
export function targetsNeedApproval(
  owner: { allowedTargets: TargetRule[] },
  inputSchema: unknown,
  inputs: Record<string, unknown>,
  teams: string[],
): boolean {
  const rules = owner.allowedTargets.filter((rule) => rule.teams.includes("*") || rule.teams.some((team) => teams.includes(team)));
  const allows = (rule: TargetRule, kind: string, value: string) => (rule.targets[kind] ?? []).some((p) => matchesTarget(p, value));
  for (const [name, kind] of targetInputs(inputSchema)) {
    const value = inputs[name];
    if (typeof value !== "string") continue;
    if (rules.some((rule) => !rule.approval && allows(rule, kind, value))) continue;
    if (rules.some((rule) => rule.approval && allows(rule, kind, value))) return true;
  }
  return false;
}

/**
 * Why these inputs aim the owner's product somewhere `teams` may not, one
 * problem per input; none when every target input is allowed (or comes
 * from an earlier step).
 */
export function targetProblems(
  owner: { name: string; allowedTargets: TargetRule[] },
  inputSchema: unknown,
  inputs: Record<string, unknown>,
  teams: string[],
): { field: string; message: string }[] {
  const problems: { field: string; message: string }[] = [];
  for (const [name, kind] of targetInputs(inputSchema)) {
    const value = inputs[name];
    if (value === undefined || (isRecord(value) && "$fromTask" in value)) continue;
    const allowed = allowedValues(owner.allowedTargets, teams, kind);
    if (typeof value === "string" && allowed.some((pattern) => matchesTarget(pattern, value))) continue;
    problems.push({
      field: name,
      message:
        allowed.length > 0
          ? `${owner.name} lets your team use ${kind} ${allowed.join(", ")} here, not ${JSON.stringify(value)}.`
          : `${owner.name} doesn't let your team aim this at any ${kind}: ask them to add one to their team.yaml's allowedTargets.`,
    });
  }
  return problems;
}

/** A pattern ("*" matches any run of characters) as a regular expression, the kernel's (JSON Schema) and this. */
function schemaPattern(pattern: string): string {
  return `^${pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")}$`;
}

/**
 * The input schema with each target input that another step will fill
 * ($fromTask) limited to what the owner's rules let `teams` use without an
 * approval, for the kernel to enforce once the value is known. `refused`:
 * the inputs no rule lets them fill that way at all.
 */
export function narrowWiredTargets(
  owner: { allowedTargets: TargetRule[] },
  inputSchema: unknown,
  inputs: Record<string, unknown>,
  teams: string[],
): { schema: unknown; refused: { field: string; kind: string }[] } {
  const wired = [...targetInputs(inputSchema)].filter(([name]) => {
    const value = inputs[name];
    return isRecord(value) && "$fromTask" in value;
  });
  if (wired.length === 0 || !isRecord(inputSchema) || !isRecord(inputSchema["properties"])) return { schema: inputSchema, refused: [] };
  const rules = owner.allowedTargets.filter((rule) => !rule.approval && (rule.teams.includes("*") || rule.teams.some((team) => teams.includes(team))));
  const properties: Record<string, unknown> = { ...inputSchema["properties"] };
  const refused: { field: string; kind: string }[] = [];
  for (const [name, kind] of wired) {
    const patterns = rules.flatMap((rule) => rule.targets[kind] ?? []);
    if (patterns.length === 0) {
      refused.push({ field: name, kind });
      continue;
    }
    properties[name] = { allOf: [properties[name] ?? {}, { anyOf: patterns.map((p) => ({ type: "string", pattern: schemaPattern(p) })) }] };
  }
  return { schema: { ...inputSchema, properties }, refused };
}
