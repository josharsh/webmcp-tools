/**
 * Valibot adapter for webmcp-tools.
 *
 * Import once anywhere to enable automatic Valibot -> JSON Schema conversion
 * for tool input descriptors:
 *
 * ```ts
 * import "webmcp-tools/valibot";
 * ```
 */
import { toJsonSchema } from "@valibot/to-json-schema";
import { registerSchemaConverter } from "./schema.js";
import type { JsonSchema, StandardSchemaV1 } from "./types.js";

export function valibotToJsonSchema(schema: StandardSchemaV1): JsonSchema {
  return toJsonSchema(schema as never, {
    typeMode: "input",
  }) as JsonSchema;
}

registerSchemaConverter("valibot", valibotToJsonSchema);
