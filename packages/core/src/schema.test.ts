import { describe, expect, it } from "vitest";
import {
  isStandardSchema,
  registerSchemaConverter,
  resolveInputSchema,
  validateJsonSchema,
  validateStandardSchema,
  ToolInputError,
} from "./schema.js";
import type { JsonSchema, StandardSchemaV1 } from "./types.js";

function fakeStandardSchema(
  vendor: string,
  validate: StandardSchemaV1.Props["validate"] = (value) => ({ value }),
): StandardSchemaV1 {
  return { "~standard": { version: 1, vendor, validate } };
}

describe("isStandardSchema", () => {
  it("accepts objects implementing the Standard Schema V1 interface", () => {
    expect(isStandardSchema(fakeStandardSchema("test"))).toBe(true);
  });

  it("rejects primitives, null, and plain objects", () => {
    expect(isStandardSchema(null)).toBe(false);
    expect(isStandardSchema(undefined)).toBe(false);
    expect(isStandardSchema("schema")).toBe(false);
    expect(isStandardSchema(42)).toBe(false);
    expect(isStandardSchema({})).toBe(false);
  });

  it("rejects raw JSON Schema objects", () => {
    expect(isStandardSchema({ type: "object", properties: {} })).toBe(false);
  });

  it('rejects objects with a "~standard" key but no validate function', () => {
    expect(isStandardSchema({ "~standard": { version: 1 } })).toBe(false);
    expect(isStandardSchema({ "~standard": null })).toBe(false);
  });
});

describe("validateStandardSchema", () => {
  it("returns the validated (possibly transformed) value", async () => {
    const schema = fakeStandardSchema("test", (value) => ({
      value: { wrapped: value },
    }));
    await expect(validateStandardSchema("t", schema, 1)).resolves.toEqual({
      wrapped: 1,
    });
  });

  it("throws ToolInputError when the schema reports issues", async () => {
    const schema = fakeStandardSchema("test", () => ({
      issues: [{ message: "nope", path: ["a"] }],
    }));
    await expect(validateStandardSchema("t", schema, 1)).rejects.toThrow(
      ToolInputError,
    );
    await expect(validateStandardSchema("t", schema, 1)).rejects.toThrow(
      'Invalid input for tool "t": a: nope',
    );
  });
});

describe("validateJsonSchema", () => {
  const objectSchema = (
    props: Record<string, JsonSchema>,
    extra?: JsonSchema,
  ) => ({ type: "object", properties: props, ...extra }) as JsonSchema;

  it("accepts valid input", () => {
    expect(() =>
      validateJsonSchema(
        "t",
        objectSchema(
          { n: { type: "number" }, s: { type: "string" } },
          { required: ["n"] },
        ),
        { n: 1, s: "x" },
      ),
    ).not.toThrow();
  });

  it("rejects type mismatches with the path in the message", () => {
    expect(() =>
      validateJsonSchema("t", objectSchema({ n: { type: "number" } }), {
        n: "five",
      }),
    ).toThrow('Invalid input for tool "t": n: expected "number", got string');
  });

  it("treats integers as valid numbers but not floats as integers", () => {
    const schema = objectSchema({ i: { type: "integer" } });
    expect(() => validateJsonSchema("t", schema, { i: 2 })).not.toThrow();
    expect(() => validateJsonSchema("t", schema, { i: 1.5 })).toThrow(
      ToolInputError,
    );
    // integer values satisfy "number"
    expect(() =>
      validateJsonSchema("t", objectSchema({ n: { type: "number" } }), {
        n: 3,
      }),
    ).not.toThrow();
  });

  it("supports type arrays (union types)", () => {
    const schema = objectSchema({ v: { type: ["string", "null"] } });
    expect(() => validateJsonSchema("t", schema, { v: "a" })).not.toThrow();
    expect(() => validateJsonSchema("t", schema, { v: null })).not.toThrow();
    expect(() => validateJsonSchema("t", schema, { v: 1 })).toThrow(
      ToolInputError,
    );
  });

  it("rejects missing required properties", () => {
    expect(() =>
      validateJsonSchema(
        "t",
        objectSchema({ a: { type: "string" } }, { required: ["a"] }),
        {},
      ),
    ).toThrow('missing required property "a"');
  });

  it("enforces enum", () => {
    const schema = objectSchema({ size: { type: "string", enum: ["s", "m"] } });
    expect(() => validateJsonSchema("t", schema, { size: "m" })).not.toThrow();
    expect(() => validateJsonSchema("t", schema, { size: "xl" })).toThrow(
      'must be one of ["s","m"]',
    );
  });

  it("enforces const, including deep equality for objects", () => {
    const schema = objectSchema({ v: { const: { a: 1 } } });
    expect(() =>
      validateJsonSchema("t", schema, { v: { a: 1 } }),
    ).not.toThrow();
    expect(() => validateJsonSchema("t", schema, { v: { a: 2 } })).toThrow(
      "must equal",
    );
  });

  it("enforces minimum/maximum on numbers", () => {
    const schema = objectSchema({
      n: { type: "number", minimum: 1, maximum: 5 },
    });
    expect(() => validateJsonSchema("t", schema, { n: 3 })).not.toThrow();
    expect(() => validateJsonSchema("t", schema, { n: 0 })).toThrow(
      "minimum 1",
    );
    expect(() => validateJsonSchema("t", schema, { n: 9 })).toThrow(
      "maximum 5",
    );
  });

  it("enforces minLength/maxLength/pattern on strings", () => {
    const schema = objectSchema({
      s: { type: "string", minLength: 2, maxLength: 4, pattern: "^[a-z]+$" },
    });
    expect(() => validateJsonSchema("t", schema, { s: "abc" })).not.toThrow();
    expect(() => validateJsonSchema("t", schema, { s: "a" })).toThrow(
      "minLength 2",
    );
    expect(() => validateJsonSchema("t", schema, { s: "abcde" })).toThrow(
      "maxLength 4",
    );
    expect(() => validateJsonSchema("t", schema, { s: "AB" })).toThrow(
      "must match pattern ^[a-z]+$",
    );
  });

  it("validates items with array index in the path", () => {
    const schema = objectSchema({
      tags: { type: "array", items: { type: "string" } },
    });
    expect(() =>
      validateJsonSchema("t", schema, { tags: ["a", "b"] }),
    ).not.toThrow();
    expect(() => validateJsonSchema("t", schema, { tags: ["a", 1] })).toThrow(
      'tags.1: expected "string", got integer',
    );
  });

  it("reports nested object paths", () => {
    const schema = objectSchema({
      user: {
        type: "object",
        properties: { age: { type: "number" } },
        required: ["age"],
      },
    });
    expect(() => validateJsonSchema("t", schema, { user: {} })).toThrow(
      'user: missing required property "age"',
    );
    expect(() =>
      validateJsonSchema("t", schema, { user: { age: "old" } }),
    ).toThrow('user.age: expected "number", got string');
  });

  it("rejects unexpected properties when additionalProperties is false", () => {
    const schema = objectSchema(
      { a: { type: "string" } },
      { additionalProperties: false },
    );
    expect(() => validateJsonSchema("t", schema, { a: "x" })).not.toThrow();
    expect(() => validateJsonSchema("t", schema, { a: "x", b: 1 })).toThrow(
      'unexpected property "b"',
    );
  });

  it("collects multiple issues into one ToolInputError", () => {
    const schema = objectSchema(
      { a: { type: "string" }, b: { type: "number" } },
      { required: ["a", "b"] },
    );
    try {
      validateJsonSchema("t", schema, {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolInputError);
      expect((err as ToolInputError).issues).toHaveLength(2);
    }
  });
});

describe("ToolInputError", () => {
  it("joins paths (plain keys and PathSegment objects) into the message", () => {
    const err = new ToolInputError("cart", [
      { message: "too small", path: ["items", 0, { key: "qty" }] },
      { message: "missing" },
    ]);
    expect(err.message).toBe(
      'Invalid input for tool "cart": items.0.qty: too small; missing',
    );
    expect(err.name).toBe("ToolInputError");
    expect(err.issues).toHaveLength(2);
  });
});

describe("resolveInputSchema", () => {
  it("prefers explicit inputJsonSchema over everything", () => {
    const explicit: JsonSchema = { type: "object", properties: { x: {} } };
    const raw: JsonSchema = { type: "object", properties: { y: {} } };
    expect(resolveInputSchema("t", raw, explicit)).toBe(explicit);
    // explicit also bypasses the converter requirement for standard schemas
    expect(
      resolveInputSchema("t", fakeStandardSchema("no-converter"), explicit),
    ).toBe(explicit);
  });

  it("returns an empty object schema when input is undefined", () => {
    expect(resolveInputSchema("t", undefined, undefined)).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("passes raw JSON Schema input through unchanged", () => {
    const raw: JsonSchema = { type: "object", properties: { y: {} } };
    expect(resolveInputSchema("t", raw, undefined)).toBe(raw);
  });

  it("throws a helpful error for standard schemas with no registered converter", () => {
    const schema = fakeStandardSchema("mystery-vendor");
    expect(() => resolveInputSchema("my-tool", schema, undefined)).toThrow(
      /webmcp-kit\/zod/,
    );
    expect(() => resolveInputSchema("my-tool", schema, undefined)).toThrow(
      /mystery-vendor/,
    );
    expect(() => resolveInputSchema("my-tool", schema, undefined)).toThrow(
      /my-tool/,
    );
  });

  it("uses a converter registered via registerSchemaConverter", () => {
    const converted: JsonSchema = { type: "object", properties: { z: {} } };
    registerSchemaConverter("fake-vendor", () => converted);
    expect(
      resolveInputSchema("t", fakeStandardSchema("fake-vendor"), undefined),
    ).toBe(converted);
  });
});
