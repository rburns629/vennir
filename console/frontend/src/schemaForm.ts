// SPDX-License-Identifier: MIT
/**
 * A run form from a template's parameter schema (or an action's input
 * schema): JSON Schema for an object, as the catalog's teams write it. Each
 * property becomes a field: text, a number, a yes/no, a choice from its
 * enum, a list (an array of text or numbers), name/value pairs (an object of
 * strings), or JSON for anything richer. A schema with no properties to show
 * gets one JSON box for the whole object.
 *
 * The form says what it can before sending (a required field, a pattern, a
 * length or a limit), on the field; the server checks the result against the
 * full schema (../../src/core/templates.ts), and its problems are put back on
 * their fields too. The catalog's form hints shape it: x-vennir-order,
 * x-vennir-group, x-vennir-widget (textarea) and x-vennir-pattern-message
 * (catalog-template/tools/product.schema.json).
 */

export type FieldKind = "text" | "number" | "integer" | "boolean" | "choice" | "list" | "map" | "json";

/** What the form checks before sending: the schema's own keywords. */
export interface Rules {
  pattern?: string;
  /** Said when the pattern doesn't match, instead of the pattern. */
  patternMessage?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
}

export interface Field {
  name: string;
  kind: FieldKind;
  label: string;
  description: string | undefined;
  required: boolean;
  /** For a choice: its allowed values. */
  choices: unknown[];
  /** Long text gets a bigger box. */
  multiline: boolean;
  /** The heading it's shown under (x-vennir-group), if any. */
  group: string | undefined;
  /** For a list: what each item is. */
  itemKind: "text" | "number" | "integer";
  rules: Rules;
}

/** What's typed: text for most fields, a yes/no, a list's items, or name/value pairs. */
export type FieldValue = string | boolean | string[] | [string, string][];
export type Values = Record<string, FieldValue>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const num = (value: unknown) => (typeof value === "number" ? value : undefined);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

const SCALAR: Record<string, Field["itemKind"]> = { string: "text", number: "number", integer: "integer" };

function kindOf(property: Record<string, unknown>): FieldKind {
  if (Array.isArray(property["enum"]) && property["enum"].length > 0) return "choice";
  switch (property["type"]) {
    case "string":
      return "text";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "array": {
      const items = property["items"];
      return isRecord(items) && SCALAR[String(items["type"])] && !items["enum"] ? "list" : "json";
    }
    case "object": {
      const values = property["additionalProperties"];
      const named = isRecord(property["properties"]) && Object.keys(property["properties"]).length > 0;
      return !named && isRecord(values) && values["type"] === "string" ? "map" : "json";
    }
    default:
      return "json";
  }
}

function rulesOf(property: Record<string, unknown>, kind: FieldKind): Rules {
  const source = kind === "list" && isRecord(property["items"]) ? { ...property["items"], ...property } : property;
  const rules: Rules = {
    pattern: str(source["pattern"]),
    patternMessage: str(source["x-vennir-pattern-message"]),
    minLength: num(source["minLength"]),
    maxLength: num(source["maxLength"]),
    minimum: num(source["minimum"]),
    maximum: num(source["maximum"]),
    exclusiveMinimum: num(source["exclusiveMinimum"]),
    exclusiveMaximum: num(source["exclusiveMaximum"]),
    minItems: num(property["minItems"]),
    maxItems: num(property["maxItems"]),
  };
  return Object.fromEntries(Object.entries(rules).filter(([, v]) => v !== undefined)) as Rules;
}

/** The form's fields in order (x-vennir-order first, then as written), or null when the schema has no properties to show (edit it as JSON). */
export function fieldsOf(schema: Record<string, unknown>): Field[] | null {
  const properties = schema["properties"];
  if (!isRecord(properties) || Object.keys(properties).length === 0) return null;
  const required = new Set(Array.isArray(schema["required"]) ? schema["required"].map(String) : []);
  const fields = Object.entries(properties).map(([name, raw], written) => {
    const property = isRecord(raw) ? raw : {};
    const kind = kindOf(property);
    const items = isRecord(property["items"]) ? property["items"] : {};
    const maxLength = num(property["maxLength"]);
    const field: Field = {
      name,
      kind,
      label: str(property["title"]) ?? name,
      description: str(property["description"]),
      required: required.has(name),
      choices: kind === "choice" ? (property["enum"] as unknown[]) : [],
      multiline: kind === "json" || property["x-vennir-widget"] === "textarea" || (kind === "text" && maxLength !== undefined && maxLength > 200),
      group: str(property["x-vennir-group"]),
      itemKind: SCALAR[String(items["type"])] ?? "text",
      rules: rulesOf(property, kind),
    };
    return { field, order: num(property["x-vennir-order"]) ?? Number.POSITIVE_INFINITY, written };
  });
  fields.sort((a, b) => a.order - b.order || a.written - b.written);
  return fields.map((f) => f.field);
}

/** The fields under their headings, in order: those without a group under none. */
export function groupsOf(fields: Field[]): { group: string | undefined; fields: Field[] }[] {
  const groups: { group: string | undefined; fields: Field[] }[] = [];
  for (const field of fields) {
    const existing = groups.find((g) => g.group === field.group);
    if (existing) existing.fields.push(field);
    else groups.push({ group: field.group, fields: [field] });
  }
  return groups;
}

/** The form's starting values: what's given (an earlier run's), else each property's default, else empty. */
export function initialValues(schema: Record<string, unknown>, fields: Field[], given: Record<string, unknown> = {}): Values {
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const values: Values = {};
  for (const field of fields) {
    const property = properties[field.name];
    const fallback = field.name in given ? given[field.name] : isRecord(property) ? property["default"] : undefined;
    if (field.kind === "boolean") values[field.name] = fallback === true;
    else if (field.kind === "list") values[field.name] = Array.isArray(fallback) ? fallback.map(String) : [];
    else if (field.kind === "map") values[field.name] = isRecord(fallback) ? Object.entries(fallback).map(([k, v]): [string, string] => [k, String(v)]) : [];
    else if (fallback === undefined) values[field.name] = "";
    else values[field.name] = field.kind === "text" && typeof fallback === "string" ? fallback : JSON.stringify(fallback);
  }
  return values;
}

/** What's wrong with one text or number value under these rules, if anything. */
function check(value: string | number, rules: Rules): string | undefined {
  if (typeof value === "string") {
    if (rules.minLength !== undefined && [...value].length < rules.minLength) return `At least ${String(rules.minLength)} characters.`;
    if (rules.maxLength !== undefined && [...value].length > rules.maxLength) return `At most ${String(rules.maxLength)} characters.`;
    if (rules.pattern !== undefined) {
      let matches = true;
      try {
        matches = new RegExp(rules.pattern, "u").test(value);
      } catch {
        // A pattern this browser can't read: the server still checks it.
      }
      if (!matches) return rules.patternMessage ?? `Doesn't match ${rules.pattern}.`;
    }
    return undefined;
  }
  if (rules.minimum !== undefined && value < rules.minimum) return `At least ${String(rules.minimum)}.`;
  if (rules.maximum !== undefined && value > rules.maximum) return `At most ${String(rules.maximum)}.`;
  if (rules.exclusiveMinimum !== undefined && value <= rules.exclusiveMinimum) return `More than ${String(rules.exclusiveMinimum)}.`;
  if (rules.exclusiveMaximum !== undefined && value >= rules.exclusiveMaximum) return `Less than ${String(rules.exclusiveMaximum)}.`;
  return undefined;
}

/** A number typed as text, or what's wrong with it. */
function numberOf(text: string, kind: "number" | "integer"): number | string {
  const n = Number(text);
  if (!Number.isFinite(n) || (kind === "integer" && !Number.isInteger(n))) return kind === "integer" ? "A whole number." : "A number.";
  return n;
}

/**
 * What's typed as the parameters, each value its field's type, or what's
 * wrong with each field that can't be sent. An empty field is left out
 * (the schema decides whether that's allowed); a yes/no is always sent.
 */
export function toParameters(fields: Field[], values: Values): { parameters: Record<string, unknown>; errors: Record<string, string> } {
  const parameters: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.kind === "boolean") {
      parameters[field.name] = value === true;
      continue;
    }
    if (field.kind === "list") {
      const items = (Array.isArray(value) ? (value as string[]) : []).filter((item) => item.trim() !== "");
      if (items.length === 0) {
        if (field.required) errors[field.name] = "Required.";
        continue;
      }
      const { minItems, maxItems } = field.rules;
      if (minItems !== undefined && items.length < minItems) errors[field.name] = `At least ${String(minItems)}.`;
      else if (maxItems !== undefined && items.length > maxItems) errors[field.name] = `At most ${String(maxItems)}.`;
      const out: unknown[] = [];
      for (const [i, item] of items.entries()) {
        const parsed = field.itemKind === "text" ? item : numberOf(item, field.itemKind);
        const problem = typeof parsed === "string" && field.itemKind !== "text" ? parsed : check(parsed, field.rules);
        if (problem) {
          errors[field.name] ??= `Item ${String(i + 1)}: ${problem}`;
          break;
        }
        out.push(parsed);
      }
      if (!errors[field.name]) parameters[field.name] = out;
      continue;
    }
    if (field.kind === "map") {
      const pairs = (Array.isArray(value) ? (value as [string, string][]) : []).filter(([k, v]) => k.trim() !== "" || v.trim() !== "");
      if (pairs.length === 0) {
        if (field.required) errors[field.name] = "Required.";
        continue;
      }
      const names = pairs.map(([k]) => k.trim());
      if (names.some((k) => k === "")) errors[field.name] = "Every value needs a name.";
      else if (new Set(names).size !== names.length) errors[field.name] = "Each name once.";
      else parameters[field.name] = Object.fromEntries(pairs.map(([k, v]) => [k.trim(), v]));
      continue;
    }
    const text = typeof value === "string" ? value : "";
    if (text.trim() === "") {
      if (field.required) errors[field.name] = "Required.";
      continue;
    }
    switch (field.kind) {
      case "text": {
        const problem = check(text, field.rules);
        if (problem) errors[field.name] = problem;
        else parameters[field.name] = text;
        break;
      }
      case "number":
      case "integer": {
        const n = numberOf(text, field.kind);
        const problem = typeof n === "string" ? n : check(n, field.rules);
        if (problem) errors[field.name] = problem;
        else parameters[field.name] = n;
        break;
      }
      case "choice":
        // Choices are kept as their JSON, so a number or true stays one.
        parameters[field.name] = JSON.parse(text) as unknown;
        break;
      case "json":
        try {
          parameters[field.name] = JSON.parse(text) as unknown;
        } catch {
          errors[field.name] = "Not valid JSON.";
        }
        break;
    }
  }
  return { parameters, errors };
}

/**
 * The server's problems with the parameters (its Problem details:
 * `{field: "parameters.text", message}`) on their fields, and those about
 * the whole object (a missing or unexpected property) apart.
 */
export function serverProblems(problems: { field: string; message: string }[]): { fields: Record<string, string>; general: string[] } {
  const fields: Record<string, string> = {};
  const general: string[] = [];
  for (const { field, message } of problems) {
    const name = field.replace(/^parameters\.?/, "").split(".")[0];
    if (name) fields[name] = fields[name] ? `${fields[name]}; ${message}` : message;
    else general.push(message);
  }
  return { fields, general };
}

/** What a target parameter may be, as the console lists it (TargetChoice). */
export interface TargetChoice {
  parameter: string;
  type: string;
  allowed: string[];
}

/**
 * Fields for a run's target parameters (where another team's product acts):
 * a choice when its team allows exact values, otherwise the allowed
 * patterns beneath it. The console refuses any other value either way.
 */
export function withTargets(fields: Field[] | null, targets: TargetChoice[]): Field[] | null {
  if (!fields) return fields;
  return fields.map((field) => {
    const target = targets.find((t) => t.parameter === field.name);
    if (!target) return field;
    const exact = target.allowed.length > 0 && target.allowed.every((value) => !value.includes("*"));
    if (exact && field.kind === "text") return { ...field, kind: "choice", choices: target.allowed };
    const description =
      target.allowed.length > 0
        ? `Its team lets yours use ${target.type} ${target.allowed.join(", ")} (* is anything).`
        : `Its team hasn't let yours use any ${target.type}; ask them to.`;
    return { ...field, description };
  });
}
