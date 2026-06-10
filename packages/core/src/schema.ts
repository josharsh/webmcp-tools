import type { JsonSchema, StandardSchemaV1, ToolInput } from "./types.js";

/** True when `value` implements the Standard Schema V1 interface. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    "~standard" in value &&
    typeof (value as StandardSchemaV1)["~standard"]?.validate === "function"
  );
}

export class ToolInputError extends Error {
  issues: ReadonlyArray<StandardSchemaV1.Issue>;
  constructor(toolName: string, issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    const detail = issues
      .map((i) => {
        const path = i.path
          ?.map((p) => (typeof p === "object" && p !== null ? p.key : p))
          .join(".");
        return path ? `${path}: ${i.message}` : i.message;
      })
      .join("; ");
    super(`Invalid input for tool "${toolName}": ${detail}`);
    this.name = "ToolInputError";
    this.issues = issues;
  }
}

/** Validate `input` against a Standard Schema; throws ToolInputError. */
export async function validateStandardSchema<S extends StandardSchemaV1>(
  toolName: string,
  schema: S,
  input: unknown,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await schema["~standard"].validate(input);
  if (result.issues) throw new ToolInputError(toolName, result.issues);
  return result.value as StandardSchemaV1.InferOutput<S>;
}

// ---------------------------------------------------------------------------
// JSON Schema subset validation (used when `input` is a raw JSON Schema).
// Covers the practical tool-input surface: type, properties, required, enum,
// const, items, additionalProperties, min/max, minLength/maxLength, pattern.
// ---------------------------------------------------------------------------

interface Issue {
  message: string;
  path: PropertyKey[];
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function checkType(expected: unknown, v: unknown): boolean {
  const actual = typeOf(v);
  const accepted = Array.isArray(expected) ? expected : [expected];
  return accepted.some(
    (t) => t === actual || (t === "number" && actual === "integer"),
  );
}

function validateNode(
  schema: JsonSchema,
  value: unknown,
  path: PropertyKey[],
  issues: Issue[],
): void {
  if (schema.type !== undefined && !checkType(schema.type, value)) {
    issues.push({
      message: `expected ${JSON.stringify(schema.type)}, got ${typeOf(value)}`,
      path,
    });
    return;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((e) => deepEqual(e, value))
  ) {
    issues.push({
      message: `must be one of ${JSON.stringify(schema.enum)}`,
      path,
    });
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    issues.push({
      message: `must equal ${JSON.stringify(schema.const)}`,
      path,
    });
  }
  if (typeof value === "string") {
    if (
      typeof schema.minLength === "number" &&
      value.length < schema.minLength
    ) {
      issues.push({ message: `minLength ${schema.minLength}`, path });
    }
    if (
      typeof schema.maxLength === "number" &&
      value.length > schema.maxLength
    ) {
      issues.push({ message: `maxLength ${schema.maxLength}`, path });
    }
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern).test(value)
    ) {
      issues.push({ message: `must match pattern ${schema.pattern}`, path });
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      issues.push({ message: `minimum ${schema.minimum}`, path });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      issues.push({ message: `maximum ${schema.maximum}`, path });
    }
  }
  if (
    Array.isArray(value) &&
    typeof schema.items === "object" &&
    schema.items
  ) {
    value.forEach((item, i) =>
      validateNode(schema.items as JsonSchema, item, [...path, i], issues),
    );
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in obj)) {
        issues.push({ message: `missing required property "${key}"`, path });
      }
    }
    for (const [key, child] of Object.entries(props)) {
      if (key in obj) validateNode(child, obj[key], [...path, key], issues);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          issues.push({ message: `unexpected property "${key}"`, path });
        }
      }
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Validate raw input against a JSON Schema subset; throws ToolInputError. */
export function validateJsonSchema(
  toolName: string,
  schema: JsonSchema,
  input: unknown,
): void {
  const issues: Issue[] = [];
  validateNode(schema, input, [], issues);
  if (issues.length > 0) {
    throw new ToolInputError(
      toolName,
      issues.map((i) => ({ message: i.message, path: i.path })),
    );
  }
}

// ---------------------------------------------------------------------------
// Standard Schema → JSON Schema conversion (pluggable, per vendor).
// `webmcp-tools/zod` registers the Zod v4 converter as a side effect.
// ---------------------------------------------------------------------------

export type SchemaConverter = (schema: StandardSchemaV1) => JsonSchema;

const converters = new Map<string, SchemaConverter>();

export function registerSchemaConverter(
  vendor: string,
  converter: SchemaConverter,
): void {
  converters.set(vendor, converter);
}

const EMPTY_OBJECT_SCHEMA: JsonSchema = { type: "object", properties: {} };

/**
 * Resolve the JSON Schema descriptor for a tool's input definition.
 * Resolution order: explicit `inputJsonSchema` > raw JSON Schema `input` >
 * registered vendor converter for a Standard Schema input.
 */
export function resolveInputSchema(
  toolName: string,
  input: ToolInput | undefined,
  explicit: JsonSchema | undefined,
): JsonSchema {
  if (explicit) return explicit;
  if (input === undefined) return EMPTY_OBJECT_SCHEMA;
  if (!isStandardSchema(input)) return input;
  const vendor = input["~standard"].vendor;
  const convert = converters.get(vendor);
  if (!convert) {
    throw new Error(
      `webmcp-tools: no JSON Schema converter registered for "${vendor}" ` +
        `schemas (tool "${toolName}"). Either import the adapter once ` +
        `(e.g. \`import "webmcp-tools/zod"\` for Zod v4), call ` +
        `registerSchemaConverter("${vendor}", fn), or pass inputJsonSchema.`,
    );
  }
  return convert(input);
}
