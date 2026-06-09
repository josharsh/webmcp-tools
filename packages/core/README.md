# webmcp-kit

**Typed, validated, ergonomic SDK for [WebMCP](https://github.com/webmachinelearning/webmcp) — expose your site's functionality as tools AI agents can call.**

```ts
import { tool } from "webmcp-kit";
import "webmcp-kit/zod"; // once, anywhere — enables Zod → JSON Schema
import { z } from "zod";

tool("add-to-cart", {
  description: "Add a product to the shopping cart",
  input: z.object({ sku: z.string(), qty: z.number().int().positive() }),
  confirm: ({ qty }) => qty > 5 && `Add ${qty} items to your cart?`,
  async run({ sku, qty }) {
    await cart.add(sku, qty);
    return { ok: true, cartSize: cart.size };
  },
});
```

That's a fully typed, runtime-validated, human-confirmable WebMCP tool — working today in every browser.

> **Note:** the `webmcp-kit/zod` adapter requires the **Zod v4 API**. It imports from the `zod/v4` subpath, which exists in Zod 3.25+ (where v4 ships alongside v3) and in Zod 4. On Zod 3.25.x, build your schemas with `import { z } from "zod/v4"`; on Zod 4, plain `import { z } from "zod"` is already the v4 API.

## What is WebMCP?

[WebMCP](https://github.com/webmachinelearning/webmcp) is a W3C Web Machine Learning CG proposal that lets web pages expose client-side functionality as "tools" — natural-language-described, JSON-Schema-typed functions that AI agents (browser-built-in, extension-hosted, or iframe-embedded) can discover and invoke via `document.modelContext`. Instead of agents scraping your DOM and simulating clicks, your page tells them exactly what it can do, and they call it directly while the user watches the same UI update.

Chrome ships an early implementation behind an **origin trial starting in Chrome 149**. Everywhere else, `document.modelContext` doesn't exist yet — which is exactly the gap this kit fills.

## Quickstart

```sh
npm install webmcp-kit zod
```

```ts
import { tool, getRegisteredTools } from "webmcp-kit";
import "webmcp-kit/zod";
import { z } from "zod"; // zod 4 (on zod 3.25.x: import { z } from "zod/v4")

const search = tool("search-products", {
  description: "Search the product catalog",
  input: z.object({ query: z.string().min(1) }),
  readOnly: true, // → annotations.readOnlyHint
  run({ query }) {
    return { results: catalog.search(query) };
  },
});

getRegisteredTools(); // → [RegisteredTool] — enumerable, testable
search.execute({ query: "lamp" }); // invoke locally exactly as an agent would
search.unregister(); // gone, everywhere
```

No schema library? Pass raw JSON Schema as `input` instead — the kit still validates `type`/`required`/`properties` at the boundary.

Tool names must match the spec constraint: **1–128 characters from `[A-Za-z0-9_.-]`**. `tool()` throws on anything else.

## Confirm gates

`confirm` puts a human-in-the-loop check in front of destructive tools:

```ts
tool("delete-account", {
  description: "Permanently delete the user's account",
  confirm: "Really delete your account?", // true | string | (args) => …
  run: () => account.delete(),
});
```

The prompt routes through the spec's `ModelContextClient.requestUserInteraction` when the browser supports it (so the agent loop pauses); the fallback is `window.confirm`, and in non-interactive contexts with no handler configured the default is **deny**. Configure with `configure({ confirmHandler })`.

## Declarative forms

Annotate the forms you already have:

```html
<form
  toolname="subscribe"
  tooldescription="Subscribe to the newsletter"
  toolautosubmit
>
  <input
    name="email"
    type="email"
    required
    toolparamdescription="Email address"
  />
  <button>Subscribe</button>
</form>
```

```ts
import { autoRegisterForms } from "webmcp-kit";
autoRegisterForms(); // registers every form[toolname], watches the DOM
```

Field names and types become the input schema (`email` → `{ type: "string", format: "email" }`, `required` honored); `toolparamdescription` on a control becomes the property's description. Executing the tool fills the fields (dispatching `input`/`change` so React/Vue controlled inputs notice) and then — per the [declarative explainer](https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md) — **only submits if the form has `toolautosubmit`** (or `formTool(form, { autoSubmit: true })`). Without it, the submit control is focused and the agent is told the user must review and submit manually. Attribute changes (`toolname`, `tooldescription`, `toolautosubmit`) re-register the tool live; removing `toolname` unregisters it.

## Works in every browser today (ponyfill)

In browsers without WebMCP the kit installs a spec-compliant ponyfill of `document.modelContext` (the default `missingHost: "ponyfill"` strategy), so registration semantics are identical everywhere. It also implements a provisional agent-side surface — `getTools()` / `executeTool()` — so bridges, dev panels, and tests have something real to talk to. When a native implementation lands, it takes over: the ponyfill defines `document.modelContext` as configurable, and `tool()` always prefers the native host. Feature-detect with `hasNativeWebMCP()` / `hasWebMCP()`.

In SSR/Node (no `document`), registration is a safe no-op (or set `missingHost: "throw"` to fail fast).

## Scoped exposure (`exposedTo`)

Tools default to same-origin/built-in-agent visibility. `exposedTo` selectively exposes a tool to specific agent origins:

```ts
tool("inventory-sync", {
  description: "Sync inventory with the partner dashboard",
  exposedTo: ["https://partner.example"],
  run: () => sync(),
});
```

The ponyfill validates each entry at registration (must be a serialized, potentially trustworthy origin — https, or http on localhost — else it rejects with a `SecurityError`) and enforces visibility on `getTools({ origin })` / `executeTool(…, { origin })`: non-visible tools are indistinguishable from unregistered ones. The [MCP bridge](https://github.com/josharsh/webmcp-kit/tree/main/packages/mcp-bridge) applies the same filter against the connected peer's origin.

## Security

Tools are an attack surface — an agent is an untrusted caller influenced by page content, user prompts, and potentially injected instructions:

- **Validation at the boundary.** Every invocation is validated against the tool's schema _before_ `run` executes — Standard Schema validation for Zod/Valibot/ArkType inputs, structural JSON Schema checks otherwise. Malformed input is rejected with an `isError` result, never thrown into your app.
- **Confirm gates** for destructive actions (see above) — the spec's recommended defense against prompt injection driving unwanted tool calls.
- **`untrustedContent: true`** sets the spec's `untrustedContentHint` annotation so agent harnesses treat your tool's output as data, not instructions.
- **`exposedTo`** keeps tools scoped to the origins you name (see above).

## API reference

| Export                                             | Description                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `tool(name, definition)`                           | Register a typed, validated tool. Returns a `RegisteredTool` handle.                                    |
| `RegisteredTool`                                   | `{ name, descriptor, exposedTo?, ready, execute(), unregister(), unregistered }`                        |
| `configure(options)` / `getConfig()`               | Kit-wide config: `confirmHandler`, `missingHost` (`"ponyfill"` \| `"noop"` \| `"throw"`).               |
| `getRegisteredTools()` / `getRegisteredTool(name)` | Enumerate / look up kit-registered tools.                                                               |
| `onRegistryChange(listener)`                       | Subscribe to register/unregister events. Returns an unsubscribe fn.                                     |
| `formTool(form, options?)`                         | Synthesize a tool from a `<form>`. Options: `name`, `description`, `confirm`, `autoSubmit`, `onSubmit`. |
| `autoRegisterForms(root?)`                         | Register every `form[toolname]`, watch for DOM and attribute changes. Returns cleanup fn.               |
| `hasNativeWebMCP()` / `hasWebMCP()`                | Feature detection (native vs. any host).                                                                |
| `installPonyfill(doc?)` / `isPonyfill(ctx)`        | Manual ponyfill control (imported via `webmcp-kit/ponyfill` for side-effect-free installs).             |
| `registerSchemaConverter(vendor, fn)`              | Plug in descriptor generation for other Standard Schema vendors.                                        |
| `normalizeResult(value)` / `errorResult(msg)`      | MCP `CallToolResult` helpers.                                                                           |
| `webmcp-kit/zod`                                   | Side-effect import: Zod (v4 API) → JSON Schema descriptor generation.                                   |

## Framework adapters & bridge

| Package                                                                          | What it is                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`@webmcp-kit/react`](https://www.npmjs.com/package/@webmcp-kit/react)           | React hooks: `useWebMCPTool`, `useRegisteredTools`             |
| [`@webmcp-kit/vue`](https://www.npmjs.com/package/@webmcp-kit/vue)               | Vue 3 composables tied to component lifecycle                  |
| [`@webmcp-kit/svelte`](https://www.npmjs.com/package/@webmcp-kit/svelte)         | Svelte action + runes helper + tools store                     |
| [`@webmcp-kit/mcp-bridge`](https://www.npmjs.com/package/@webmcp-kit/mcp-bridge) | Real MCP server over `postMessage` for extension/iframe agents |

## License

[MIT](./LICENSE)
