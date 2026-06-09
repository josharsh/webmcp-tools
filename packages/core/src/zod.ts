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
 * Requires the Zod v4 API, imported via the `zod/v4` subpath — available in
 * both Zod 3.25+ (where v4 ships alongside v3) and Zod 4. Zod 3.24+ schemas
 * still validate at runtime via Standard Schema without this adapter — only
 * descriptor generation needs it (or pass `inputJsonSchema` explicitly).
 * Note: schemas you pass to `tool()` must be built with the v4 API
 * (`import { z } from "zod/v4"` on Zod 3.25.x, or plain `"zod"` on Zod 4).
 */
import { toJSONSchema } from "zod/v4";
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
