// SPDX-License-Identifier: MIT
/**
 * The API reference (Docs → API reference), from the protos themselves:
 * reads a buf image with source info (`buf build`, run by `make proto`)
 * and prints its services, methods, messages and enums, with their
 * comments, as JSON for the frontend (frontend/src/gen/api-reference.json).
 *
 *   tsx scripts/api-reference.ts image.binpb > frontend/src/gen/api-reference.json
 */
import { readFileSync } from "node:fs";
import { fromBinary } from "@bufbuild/protobuf";
import {
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FileDescriptorSetSchema,
  MethodOptions_IdempotencyLevel,
  type DescriptorProto,
  type EnumDescriptorProto,
  type FieldDescriptorProto,
  type FileDescriptorProto,
} from "@bufbuild/protobuf/wkt";

/** Methods anyone may call, signed in or not: rpc/interceptors.ts's PUBLIC
 * (test/api-reference.test.ts keeps the two the same). */
export const PUBLIC_METHODS = [
  "vennir.console.v1.AuthService/GetEnvironment",
  "vennir.console.v1.AuthService/Register",
  "vennir.console.v1.AuthService/Login",
  "vennir.console.v1.AuthService/ExchangeToken",
];

interface Field {
  name: string;
  type: string;
  /** The message or enum it refers to (its full name), for a link. */
  ref?: string;
  repeated: boolean;
  optional: boolean;
  comment: string;
}

const SCALARS: Partial<Record<FieldDescriptorProto_Type, string>> = {
  [FieldDescriptorProto_Type.STRING]: "string",
  [FieldDescriptorProto_Type.BOOL]: "boolean",
  [FieldDescriptorProto_Type.INT32]: "integer",
  [FieldDescriptorProto_Type.UINT32]: "integer",
  [FieldDescriptorProto_Type.SINT32]: "integer",
  // 64-bit integers are strings in JSON, so no precision is lost.
  [FieldDescriptorProto_Type.INT64]: "integer (as a string)",
  [FieldDescriptorProto_Type.UINT64]: "integer (as a string)",
  [FieldDescriptorProto_Type.SINT64]: "integer (as a string)",
  [FieldDescriptorProto_Type.DOUBLE]: "number",
  [FieldDescriptorProto_Type.FLOAT]: "number",
  [FieldDescriptorProto_Type.BYTES]: "bytes (base64)",
};

/** How well-known types appear in JSON. */
const WELL_KNOWN: Record<string, string> = {
  ".google.protobuf.Struct": "object",
  ".google.protobuf.Value": "any JSON value",
  ".google.protobuf.Timestamp": "timestamp (RFC 3339 string)",
  ".google.protobuf.Duration": "duration (string, e.g. \"3.5s\")",
};

const [imagePath] = process.argv.slice(2);
if (!imagePath) throw new Error("usage: api-reference.ts IMAGE");
const image = fromBinary(FileDescriptorSetSchema, readFileSync(imagePath));
const files = image.file.filter((f) => f.package.startsWith("vennir."));

/** Every message's DescriptorProto by full name (".pkg.Name"), maps included. */
const allMessages = new Map<string, DescriptorProto>();
for (const file of image.file) {
  const walk = (prefix: string, messages: DescriptorProto[]) => {
    for (const m of messages) {
      allMessages.set(`${prefix}.${m.name}`, m);
      walk(`${prefix}.${m.name}`, m.nestedType);
    }
  };
  walk(`.${file.package}`, file.messageType);
}

function commentsOf(file: FileDescriptorProto) {
  const byPath = new Map<string, string>();
  for (const location of file.sourceCodeInfo?.location ?? []) {
    const text = (location.leadingComments ?? "")
      .split("\n")
      .map((line) => line.replace(/^ /, ""))
      .join("\n")
      .trim();
    if (text) byPath.set(location.path.join("."), text);
  }
  return (path: number[]) => byPath.get(path.join(".")) ?? "";
}

function typeOf(field: FieldDescriptorProto): Pick<Field, "type" | "ref"> {
  const scalar = SCALARS[field.type];
  if (scalar) return { type: scalar };
  const wellKnown = WELL_KNOWN[field.typeName];
  if (wellKnown) return { type: wellKnown };
  const ref = field.typeName.slice(1);
  return { type: ref.split(".").pop() ?? ref, ref };
}

function fieldOf(field: FieldDescriptorProto, comment: string): Field {
  const repeated = field.label === FieldDescriptorProto_Label.REPEATED;
  const entry = field.type === FieldDescriptorProto_Type.MESSAGE ? allMessages.get(field.typeName) : undefined;
  if (repeated && entry?.options?.mapEntry) {
    const [key, value] = entry.field;
    if (!key || !value) throw new Error(`map ${field.name} has no key and value`);
    const v = typeOf(value);
    return { name: field.jsonName, type: `map of ${typeOf(key).type} to ${v.type}`, ref: v.ref, repeated: false, optional: false, comment };
  }
  return { name: field.jsonName, ...typeOf(field), repeated, optional: field.proto3Optional, comment };
}

const services = [];
const messages: Record<string, { name: string; comment: string; fields: Field[] }> = {};
const enums: Record<string, { name: string; comment: string; values: { name: string; comment: string }[] }> = {};

for (const file of files) {
  const comment = commentsOf(file);
  file.service.forEach((service, s) => {
    const fullName = `${file.package}.${service.name}`;
    services.push({
      name: service.name,
      fullName,
      comment: comment([6, s]),
      methods: service.method.map((method, m) => ({
        name: method.name,
        comment: comment([6, s, 2, m]),
        input: method.inputType.slice(1),
        output: method.outputType.slice(1),
        streaming: method.serverStreaming,
        idempotency:
          method.options?.idempotencyLevel === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS
            ? "read"
            : method.options?.idempotencyLevel === MethodOptions_IdempotencyLevel.IDEMPOTENT
              ? "idempotent"
              : "",
        public: PUBLIC_METHODS.includes(`${fullName}/${method.name}`),
      })),
    });
  });
  const walkEnums = (prefix: string, list: EnumDescriptorProto[], path: number[]) => {
    list.forEach((e, i) => {
      const at = [...path, i];
      enums[`${prefix}.${e.name}`] = {
        name: e.name,
        comment: comment(at),
        values: e.value.map((v, j) => ({ name: v.name, comment: comment([...at, 2, j]) })),
      };
    });
  };
  const walkMessages = (prefix: string, list: DescriptorProto[], path: number[]) => {
    list.forEach((m, i) => {
      const at = [...path, i];
      if (m.options?.mapEntry) return;
      messages[`${prefix}.${m.name}`] = {
        name: m.name,
        comment: comment(at),
        fields: m.field.map((f, j) => fieldOf(f, comment([...at, 2, j]))),
      };
      walkMessages(`${prefix}.${m.name}`, m.nestedType, [...at, 3]);
      walkEnums(`${prefix}.${m.name}`, m.enumType, [...at, 4]);
    });
  };
  walkMessages(file.package, file.messageType, [4]);
  walkEnums(file.package, file.enumType, [5]);
}

services.sort((a, b) => a.name.localeCompare(b.name));
process.stdout.write(JSON.stringify({ services, messages, enums }, null, 1) + "\n");
