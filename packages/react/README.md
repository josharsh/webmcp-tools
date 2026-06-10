# @josharsh/webmcp-react

React hooks for [webmcp-tools](https://github.com/josharsh/webmcp-tools). Register WebMCP (`document.modelContext`) tools from components with automatic cleanup, and let `run`/`confirm` read the latest props and state without re-registering on every render.

## Install

```sh
npm install @josharsh/webmcp-react webmcp-tools
```

## Usage

```tsx
import { useWebMCPTool } from "@josharsh/webmcp-react";
import { z } from "zod";
import "webmcp-tools/zod"; // once, anywhere — enables Zod → JSON Schema

function Cart({ items }: { items: CartItem[] }) {
  useWebMCPTool("get-cart", {
    description: "List the items currently in the shopping cart",
    readOnly: true,
    run: () => ({ items }), // always sees the latest `items` — no deps needed
  });

  useWebMCPTool("remove-from-cart", {
    description: "Remove a product from the cart by SKU",
    input: z.object({ sku: z.string() }),
    confirm: ({ sku }) => `Remove ${sku} from your cart?`,
    run: ({ sku }) => removeItem(sku),
  });

  return <ul>{/* ... */}</ul>;
}
```

Reactive tool list (e.g. for a devtools panel):

```tsx
import { useRegisteredTools, useWebMCPForms } from "@josharsh/webmcp-react";

function AgentPanel() {
  useWebMCPForms(); // auto-register every <form toolname="..."> on the page
  const tools = useRegisteredTools();
  return (
    <ul>
      {tools.map((t) => (
        <li key={t.name}>{t.descriptor.description}</li>
      ))}
    </ul>
  );
}
```

## API

| Hook                 | Signature                                                                                | Description                                                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useWebMCPTool`      | `(name: string, definition: ToolDefinition, deps?: unknown[]) => RegisteredTool \| null` | Registers the tool on mount, unregisters on unmount, re-registers when `name` or `deps` change. `run`/`confirm` always see the latest render via a ref — pass `deps` only for things that change the descriptor (description, input schema). Returns `null` before the mount effect runs. |
| `useWebMCPForms`     | `(rootRef?: RefObject<HTMLElement \| null>) => void`                                     | Calls `autoRegisterForms` on mount for the ref element (or `document`), keeps watching for added/removed `form[toolname]` elements, cleans up on unmount.                                                                                                                                 |
| `useRegisteredTools` | `() => RegisteredTool[]`                                                                 | Reactive snapshot of every tool registered through webmcp-tools (including outside React), via `useSyncExternalStore`. The array reference is stable between registry changes.                                                                                                              |

Types `RegisteredTool`, `ToolDefinition`, `ToolContext`, `ToolInput`, and `ToolResult` are re-exported from `webmcp-tools` for convenience.

## License

MIT
