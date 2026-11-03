#!/usr/bin/env node
// reverse's "transform" action: the text backwards, one character as a
// reader sees it at a time, so "👋🏽" or "é" stay whole instead of splitting
// into their code points.
//
// Reads /platform/input/request.json, writes /platform/output/result.json:
// {"status": "succeeded", "outputs": {...}} or
// {"status": "failed", "error": {"code", "message", "retryable"}}.
import { readFileSync, writeFileSync } from "node:fs";

const INPUT_PATH = "/platform/input/request.json";
const OUTPUT_PATH = "/platform/output/result.json";
// The output carries the text back, and result.json is limited to 4 KB: a
// limit in characters, and the encoded result measured too, since JSON
// writes a control character as six bytes and UTF-8 others as up to four.
const MAX_LENGTH = 1000;
const MAX_RESULT_BYTES = 4096;

type Result =
  | { status: "succeeded"; outputs: { text: string; language: string } }
  | { status: "failed"; error: { code: string; message: string; retryable: boolean } };

function writeResult(result: Result): void {
  writeFileSync(OUTPUT_PATH, JSON.stringify(result));
}

function fail(code: string, message: string): number {
  writeResult({ status: "failed", error: { code, message, retryable: false } });
  return 1;
}

export function reverse(text: string): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(text), (s) => s.segment).reverse().join("");
}

function main(): number {
  const request = JSON.parse(readFileSync(INPUT_PATH, "utf8")) as { inputs?: Record<string, unknown> };
  const text = request.inputs?.["text"];
  if (typeof text !== "string" || text.trim() === "") {
    return fail("MISSING_INPUT", "inputs.text is required: the text to change.");
  }
  // Counted in code points, the way the other language samples count.
  const length = Array.from(text).length;
  if (length > MAX_LENGTH) {
    return fail("TEXT_TOO_LONG", `inputs.text is ${length} characters; the limit is ${MAX_LENGTH}.`);
  }
  // A JSON line with level info: what everyone who can see the run sees.
  // Anything else (debug, warn, error, plain) only this team sees.
  const result: Result = { status: "succeeded", outputs: { text: reverse(text), language: "TypeScript" } };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) {
    return fail("TEXT_TOO_LONG", `inputs.text would make a result over ${MAX_RESULT_BYTES} bytes.`);
  }
  console.log(JSON.stringify({ level: "info", msg: `reversed ${length} characters` }));
  writeResult(result);
  return 0;
}

process.exitCode = main();
