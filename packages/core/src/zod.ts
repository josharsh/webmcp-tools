/**
 * Zod adapter for webmcp-kit.
 *
 * Import once anywhere to enable automatic Zod → JSON Schema conversion for
 * tool input descriptors:
 *
 * ```ts
 * import "webmcp-kit/zod";
 * ```
 *
 * Requires Zod v4 (`z.toJSONSchema`). Zod 3.24+ schemas still validate at
 * runtime via Standard Schema without this adapter — only descriptor
 * generation needs it (or pass `inputJsonSchema` explicitly).
 */
import { toJSONSchema } from "zod";
import { registerSchemaConverter } from "./schema.js";
import type { JsonSchema, StandardSchemaV1 } from "./types.js";

export function zodToJsonSchema(schema: StandardSchemaV1): JsonSchema {
  // `io: "input"` documents what the agent must SEND (pre-transform/defaults).
  return toJSONSchema(schema as never, {
    io: "input",
    // Tool inputs travel as JSON; represent unsupported types loosely rather
    // than throwing at registration time.
    unrepresentable: "any",
  }) as JsonSchema;
}

registerSchemaConverter("zod", zodToJsonSchema);
