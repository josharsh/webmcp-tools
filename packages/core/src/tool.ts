import {
  isStandardSchema,
  resolveInputSchema,
  ToolInputError,
  validateJsonSchema,
  validateStandardSchema,
} from "./schema.js";
import { registryAdd, registryHas, registryRemove } from "./registry.js";
import { getModelContext } from "./host.js";
import type {
  ConfirmHandler,
  InferToolArgs,
  ModelContextClient,
  ModelContextTool,
  RegisteredTool,
  ToolContentBlock,
  ToolDefinition,
  ToolInput,
  ToolResult,
  WebMCPKitConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Kit configuration
// ---------------------------------------------------------------------------

const defaultConfirmHandler: ConfirmHandler = (message) => {
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    return window.confirm(message);
  }
  // Non-interactive context with no handler configured: deny by default.
  return false;
};

let config: Required<WebMCPKitConfig> = {
  confirmHandler: defaultConfirmHandler,
  missingHost: "ponyfill",
};

/** Configure kit-wide behavior (confirm UI, missing-host strategy). */
export function configure(options: WebMCPKitConfig): void {
  config = { ...config, ...options };
}

/** Current kit configuration (read-only snapshot). */
export function getConfig(): Required<WebMCPKitConfig> {
  return { ...config };
}

// ---------------------------------------------------------------------------
// Result normalization (MCP CallToolResult conventions)
// ---------------------------------------------------------------------------

function text(value: string): ToolContentBlock {
  return { type: "text", text: value };
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as ToolResult).content) &&
    (value as ToolResult).content.every(
      (c) => c && c.type === "text" && typeof c.text === "string",
    )
  );
}

/** Normalize whatever `run` returned into a structured ToolResult. */
export function normalizeResult(value: unknown): ToolResult {
  if (value === undefined || value === null) {
    return { content: [text("ok")] };
  }
  if (typeof value === "string") {
    return { content: [text(value)] };
  }
  if (isToolResult(value)) return value;
  return {
    content: [text(JSON.stringify(value))],
    structuredContent: value,
  };
}

export function errorResult(message: string): ToolResult {
  return { content: [text(message)], isError: true };
}

// ---------------------------------------------------------------------------
// tool() — the main API
// ---------------------------------------------------------------------------

/**
 * Register a typed, validated WebMCP tool on `document.modelContext`.
 *
 * ```ts
 * import { tool } from "webmcp-kit";
 * import "webmcp-kit/zod"; // once, anywhere — enables Zod → JSON Schema
 * import { z } from "zod";
 *
 * const addToCart = tool("add-to-cart", {
 *   description: "Add a product to the shopping cart",
 *   input: z.object({ sku: z.string(), qty: z.number().int().positive() }),
 *   confirm: ({ qty }) => qty > 5 && `Add ${qty} items to your cart?`,
 *   async run({ sku, qty }) {
 *     await cart.add(sku, qty);
 *     return { ok: true, cartSize: cart.size };
 *   },
 * });
 * // later: addToCart.unregister()
 * ```
 */
export function tool<I extends ToolInput | undefined = undefined>(
  name: string,
  definition: ToolDefinition<I>,
): RegisteredTool {
  if (!name) throw new Error("webmcp-kit: tool name must be non-empty");
  if (!definition.description) {
    throw new Error(`webmcp-kit: tool "${name}" needs a description`);
  }
  if (registryHas(name)) {
    throw new Error(
      `webmcp-kit: a tool named "${name}" is already registered. ` +
        `Unregister it first or use a unique name.`,
    );
  }

  // Resolve the JSON Schema descriptor eagerly so misconfiguration fails at
  // registration time, not first agent call.
  const inputSchema = resolveInputSchema(
    name,
    definition.input,
    definition.inputJsonSchema,
  );

  const controller = new AbortController();
  if (definition.signal) {
    if (definition.signal.aborted) controller.abort(definition.signal.reason);
    else {
      definition.signal.addEventListener(
        "abort",
        () => controller.abort(definition.signal!.reason),
        { once: true },
      );
    }
  }

  let unregistered = false;

  async function runConfirmGate(
    args: InferToolArgs<I>,
    client: ModelContextClient | undefined,
  ): Promise<ToolResult | null> {
    const option = definition.confirm;
    if (!option) return null;

    let message: string | true;
    if (typeof option === "function") {
      const decision = await option(args);
      if (decision === false) return null; // gate: no confirmation needed
      message = decision;
    } else {
      message = option as string | true;
    }
    const finalMessage =
      typeof message === "string"
        ? message
        : `Allow the agent to run "${definition.title ?? name}"?`;

    const ask = () => config.confirmHandler(finalMessage, name, args);
    // Route through the native client when present so the browser can pause
    // the agent loop during user interaction (spec ModelContextClient).
    const approved = client?.requestUserInteraction
      ? await client.requestUserInteraction(ask)
      : await ask();

    if (!approved) {
      return errorResult(`User declined to run tool "${name}".`);
    }
    return null;
  }

  async function execute(
    rawInput: Record<string, unknown>,
    client?: ModelContextClient,
  ): Promise<ToolResult> {
    if (unregistered) {
      return errorResult(`Tool "${name}" is no longer registered.`);
    }
    try {
      // 1. Validate at the boundary.
      let args: InferToolArgs<I>;
      const input = definition.input;
      if (input !== undefined && isStandardSchema(input)) {
        args = (await validateStandardSchema(
          name,
          input,
          rawInput ?? {},
        )) as InferToolArgs<I>;
      } else {
        validateJsonSchema(name, inputSchema, rawInput ?? {});
        args = (rawInput ?? {}) as InferToolArgs<I>;
      }

      // 2. Human-in-the-loop confirm gate (injection defense).
      const denied = await runConfirmGate(args, client);
      if (denied) return denied;

      // 3. Run the implementation.
      const ctx = {
        rawInput: rawInput ?? {},
        signal: controller.signal,
        requestUserInteraction: <T>(cb: () => Promise<T> | T): Promise<T> =>
          client?.requestUserInteraction
            ? client.requestUserInteraction(cb)
            : Promise.resolve(cb()),
      };
      const result = await definition.run(args, ctx);
      return normalizeResult(result);
    } catch (err) {
      if (err instanceof ToolInputError) return errorResult(err.message);
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`Tool "${name}" failed: ${message}`);
    }
  }

  const descriptor: Omit<ModelContextTool, "execute"> = {
    name,
    description: definition.description,
    inputSchema,
    ...(definition.title !== undefined && { title: definition.title }),
    ...((definition.readOnly !== undefined ||
      definition.untrustedContent !== undefined) && {
      annotations: {
        ...(definition.readOnly !== undefined && {
          readOnlyHint: definition.readOnly,
        }),
        ...(definition.untrustedContent !== undefined && {
          untrustedContentHint: definition.untrustedContent,
        }),
      },
    }),
  };

  // Register with the host (native document.modelContext or ponyfill).
  const host = getModelContext(config.missingHost);
  const ready: Promise<void> = host
    ? host.registerTool(
        { ...descriptor, execute },
        {
          signal: controller.signal,
          ...(definition.exposedTo && { exposedTo: definition.exposedTo }),
        },
      )
    : Promise.resolve();

  const handle: RegisteredTool = {
    name,
    descriptor,
    ready,
    execute,
    get unregistered() {
      return unregistered;
    },
    unregister() {
      if (unregistered) return;
      unregistered = true;
      controller.abort();
      registryRemove(handle);
    },
  };

  controller.signal.addEventListener("abort", () => handle.unregister(), {
    once: true,
  });

  registryAdd(handle);
  return handle;
}
