// SPDX-License-Identifier: MIT
/**
 * Checking values against the JSON Schemas teams write (draft 2020-12): a
 * template's parameters (core/templates.ts) and a product's inputs
 * (core/executions.ts). ajv never fetches anything here: a schema that
 * refers outside itself doesn't compile, as in the kernel
 * (kernel/internal/domain/schema.go).
 */
import ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

// A CommonJS module: its class is module.exports, and its .default too.
// verbose: each error carries the schema it failed, for its own message.
const ajv = new ajv2020.default({ allErrors: true, strict: false, verbose: true });
/** Compiled schemas, by their JSON; ajv's own cache would keep every schema object it sees. */
const compiledSchemas = new Map<string, ValidateFunction>();

function compiled(schema: unknown): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = compiledSchemas.get(key);
  if (cached) return cached;
  const object = schema ?? {};
  const validate = ajv.compile(object);
  ajv.removeSchema(object);
  if (compiledSchemas.size >= 500) compiledSchemas.clear();
  compiledSchemas.set(key, validate);
  return validate;
}

/** Why a schema can't be used, or null. */
export function schemaProblem(schema: unknown): string | null {
  try {
    compiled(schema);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** What the schema refuses in the value; none when it fits. */
export function schemaErrors(schema: unknown, value: unknown): ErrorObject[] {
  const validate = compiled(schema);
  return validate(value) ? [] : [...(validate.errors ?? [])];
}

/**
 * What's wrong, in the schema's own words where it gives them (a pattern's
 * x-vennir-pattern-message, as the console's forms show it), else ajv's.
 */
export function errorMessage(e: ErrorObject): string {
  const parent: unknown = e.parentSchema;
  const own = e.keyword === "pattern" && typeof parent === "object" && parent !== null ? (parent as Record<string, unknown>)["x-vennir-pattern-message"] : undefined;
  return typeof own === "string" && own ? own : (e.message ?? "is invalid");
}

/** An error's place in the value, dotted (".text", or "" for the value itself). */
export const errorPath = (e: ErrorObject) => e.instancePath.replaceAll("/", ".");
