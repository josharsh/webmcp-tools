# @webmcp-kit/svelte

Svelte adapter for [webmcp-kit](https://github.com/josharsh/webmcp-kit). Register typed, validated WebMCP tools (`document.modelContext`) from Svelte components — works in Svelte 4 and 5, no compiler integration needed.

## Install

```sh
pnpm add webmcp-kit @webmcp-kit/svelte
```

## Usage

### Action (Svelte 4 & 5)

The tool lives as long as the element. Updates take effect on the next call; changing `name` re-registers.

```svelte
<script>
  import { webmcpTool } from "@webmcp-kit/svelte";

  let product = { sku: "abc-123" };
</script>

<section
  use:webmcpTool={{
    name: "add-to-cart",
    description: "Add the displayed product to the cart",
    confirm: "Add this product to your cart?",
    run: () => addToCart(product.sku),
  }}
>
  ...
</section>
```

### Runes ($effect, Svelte 5)

```svelte
<script>
  import { registerTool } from "@webmcp-kit/svelte";

  let status = $state("pending");

  $effect(() => {
    const t = registerTool("get-status", {
      description: "Read the current order status",
      readOnly: true,
      run: () => status,
    });
    return () => t.unregister();
  });
</script>
```

### Store of registered tools

`registeredTools` implements the Svelte store contract (use it with `$`):

```svelte
<script>
  import { registeredTools } from "@webmcp-kit/svelte";
</script>

<ul>
  {#each $registeredTools as t}
    <li>{t.name}</li>
  {/each}
</ul>
```

## API

| Export                           | Type           | Description                                                                                                                                                                                                                                             |
| -------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webmcpTool(node, params)`       | Svelte action  | Registers `params.name` as a tool on create, unregisters on destroy. Same-name updates route the latest `run`/`confirm` without re-registering; a `name` change unregisters and re-registers. `node` is unused (lifecycle only) and may be `undefined`. |
| `registerTool(name, definition)` | function       | Plain wrapper around core `tool()` for `$effect` usage. Returns a `RegisteredTool` — call `.unregister()` in the effect cleanup.                                                                                                                        |
| `registeredTools`                | readable store | `{ subscribe(cb) }` emitting `RegisteredTool[]` on every register/unregister (initial snapshot on subscribe).                                                                                                                                           |
| `WebmcpToolParams<I>`            | type           | `{ name: string } & ToolDefinition<I>` — the action's parameter shape.                                                                                                                                                                                  |
| `WebmcpToolAction<I>`            | type           | The action's return shape: `{ update(params), destroy() }`.                                                                                                                                                                                             |

`ToolDefinition`, `RegisteredTool`, `ToolResult`, `ToolContext`, `ToolInput`, and `InferToolArgs` are re-exported from `webmcp-kit` for convenience. See the [core README](../core/README.md) for schemas (Zod/Valibot/ArkType or raw JSON Schema), confirm gates, and the ponyfill.
