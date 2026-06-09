import { getRegisteredTools, onRegistryChange, tool } from "webmcp-kit";
import type {
  InferToolArgs,
  RegisteredTool,
  ToolDefinition,
  ToolInput,
} from "webmcp-kit";

/** Parameters for the `webmcpTool` action: a tool name plus its definition. */
export type WebmcpToolParams<I extends ToolInput | undefined = undefined> = {
  /** Unique tool name. Changing it on update re-registers the tool. */
  name: string;
} & ToolDefinition<I>;

/** Return type of the `webmcpTool` action (Svelte action contract). */
export interface WebmcpToolAction<I extends ToolInput | undefined = undefined> {
  update(params: WebmcpToolParams<I>): void;
  destroy(): void;
}

function register<I extends ToolInput | undefined>(
  params: WebmcpToolParams<I>,
  current: { params: WebmcpToolParams<I> },
): RegisteredTool {
  const { name, ...definition } = params;
  // The descriptor (description, title, schema, annotations) is fixed at
  // registration time per the WebMCP spec; run/confirm are routed through
  // `current` so reactive updates take effect without re-registering.
  return tool<I>(name, {
    ...(definition as ToolDefinition<I>),
    run: (args, ctx) => current.params.run(args, ctx),
    confirm: async (args: InferToolArgs<I>) => {
      const option = current.params.confirm;
      if (option === undefined) return false;
      if (typeof option === "function") return option(args);
      return option;
    },
  });
}

/**
 * Svelte action that registers a WebMCP tool for the lifetime of an element.
 *
 * ```svelte
 * <section use:webmcpTool={{
 *   name: "add-to-cart",
 *   description: "Add the displayed product to the cart",
 *   run: () => addToCart(product.sku),
 * }} />
 * ```
 *
 * - Registers on mount, unregisters on destroy.
 * - When params update with the same `name`, the latest `run`/`confirm` are
 *   used on the next call (no re-registration).
 * - When `name` changes, the old tool is unregistered and a new one is
 *   registered from the latest params.
 *
 * The element itself is not used — the action only piggybacks on Svelte's
 * mount/destroy lifecycle, so `node` may be `undefined` when calling the
 * action manually (e.g. in tests or imperative code).
 */
export function webmcpTool<I extends ToolInput | undefined = undefined>(
  node: HTMLElement | undefined,
  params: WebmcpToolParams<I>,
): WebmcpToolAction<I> {
  void node; // lifecycle-only; the tool is not tied to a DOM node
  const current = { params };
  let handle = register(params, current);

  return {
    update(next: WebmcpToolParams<I>) {
      const renamed = next.name !== current.params.name;
      current.params = next;
      if (renamed) {
        handle.unregister();
        handle = register(next, current);
      }
    },
    destroy() {
      handle.unregister();
    },
  };
}

/**
 * Plain wrapper around core `tool()` for Svelte 5 runes users.
 *
 * ```svelte
 * <script>
 *   import { registerTool } from "@webmcp-kit/svelte";
 *
 *   $effect(() => {
 *     const t = registerTool("get-status", {
 *       description: "Read the current order status",
 *       readOnly: true,
 *       run: () => status,
 *     });
 *     return () => t.unregister();
 *   });
 * </script>
 * ```
 */
export function registerTool<I extends ToolInput | undefined = undefined>(
  name: string,
  definition: ToolDefinition<I>,
): RegisteredTool {
  return tool(name, definition);
}

/**
 * Readable-store-shaped view of all tools registered through webmcp-kit.
 * Implements the Svelte store contract (`subscribe` returning an unsubscribe
 * function) without importing svelte, so it works in Svelte 4 and 5:
 *
 * ```svelte
 * <script>
 *   import { registeredTools } from "@webmcp-kit/svelte";
 * </script>
 * {#each $registeredTools as t}<li>{t.name}</li>{/each}
 * ```
 */
export const registeredTools = {
  subscribe(run: (tools: RegisteredTool[]) => void): () => void {
    run(getRegisteredTools());
    return onRegistryChange(() => run(getRegisteredTools()));
  },
};
