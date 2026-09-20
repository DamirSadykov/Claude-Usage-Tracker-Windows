import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "board-fixtures");
const schema = JSON.parse(readFileSync(path.join(FIXTURES, "board.schema.json"), "utf8"));

import Ajv2020 from "ajv/dist/2020.js";

describe("board.schema.json — Rust-derived schema checked by Node", () => {
  const validate = new Ajv2020({ allErrors: true, validateFormats: false }).compile(schema);
  const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

  for (const name of ["v1/empty.json", "v1/full.json", "v2/empty.json", "v2/full.json", "v2/unknown-field.json", "v2/future-version.json"]) {
    it(`${name} satisfies the shared typed contract`, () => {
      expect(validate(fixture(name)), validate.errors?.map((error) => `${error.instancePath} ${error.message}`).join("; ")).toBe(true);
    });
  }

  it("rejects the fixture whose todo number is a string", () => {
    expect(validate(fixture("corrupt/todo-field-type.json"))).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([expect.objectContaining({ instancePath: "/todos/0/number" })]));
  });
});
