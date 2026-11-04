// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { errorMessage, errorPath, schemaErrors } from "../src/jsonSchema.js";

describe("what a schema refuses", () => {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string", pattern: "\\S", "x-vennir-pattern-message": "can't be blank" },
      code: { type: "string", pattern: "^[A-Z]+$" },
    },
  };

  it("is said in the schema's own words for a pattern, else ajv's", () => {
    const said = schemaErrors(schema, { title: "   ", code: "abc" }).map((e) => `${errorPath(e)} ${errorMessage(e)}`);
    expect(said).toEqual([".title can't be blank", '.code must match pattern "^[A-Z]+$"']);
  });
});
