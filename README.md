# webmcp-tools

[![npm](https://img.shields.io/npm/v/webmcp-tools)](https://www.npmjs.com/package/webmcp-tools)
[![CI](https://github.com/josharsh/webmcp-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/josharsh/webmcp-tools/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/webmcp-tools)](./LICENSE)
[![types](https://img.shields.io/badge/types-included-blue)](https://www.npmjs.com/package/webmcp-tools)

**Typed, validated, ergonomic SDK for [WebMCP](https://github.com/webmachinelearning/webmcp) — expose your site's functionality as tools AI agents can call.**

```ts
import { tool } from "webmcp-tools";
import "webmcp-tools/zod"; // once, anywhere — enables Zod → JSON Schema
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

## What is WebMCP?

[WebMCP](https://github.com/webmachinelearning/webmcp) is a W3C Web Machine Learning CG proposal that lets web pages expose client-side functionality as "tools" — natural-language-described, JSON-Schema-typed functions that AI agents (browser-built-in, extension-hosted, or iframe-embedded) can discover and invoke via `document.modelContext`. Think of it as an in-page MCP server: instead of agents scraping your DOM and simulating clicks, your page tells them exactly what it can do, and they call it directly while the user watches the same UI update.

Chrome ships an early implementation behind an **origin trial starting in Chrome 149**. Everywhere else, `document.modelContext` doesn't exist yet — which is exactly the gap this kit fills.

## What webmcp-tools adds

The raw API is deliberately minimal: untyped `Record<string, unknown>` inputs, hand-written JSON Schema, no validation, no enumeration of registered tools from page script, and nothing at all in browsers without the trial. webmcp-tools layers on:

- **Typed + validated tools** — define inputs with Zod (or any [Standard Schema](https://standardschema.dev) library: Valibot, ArkType…). The JSON Schema descriptor is generated for you, and every agent call is validated at the boundary before your code runs. Your `run` receives properly typed args.
- **Confirm gates** — `confirm: true | string | (args) => …` puts a human-in-the-loop check in front of destructive tools, routed through the spec's `ModelContextClient.requestUserInteraction` when the browser supports it.
- **Spec-compliant ponyfill** — browsers without WebMCP get a working `document.modelContext`, plus a provisional agent-side surface (`getTools()` / `executeTool()`) so bridges and tests have something real to talk to. Your code is identical everywhere.
- **Framework bindings** — `useWebMCPTool` for React, composables for Vue, actions/runes helpers for Svelte. Tools register on mount, unregister on unmount, no leaks.
- **Declarative forms** — `formTool(form)` / `autoRegisterForms()` implement the [declarative `<form toolname>` proposal](https://github.com/webmachinelearning/webmcp/blob/main/declarative-api-explainer.md) in userland, today.
- **MCP bridge** — serve your page's tools to a _real_ MCP client (extension agent, parent frame, devtool) over `postMessage`, speaking actual MCP protocol.

## Quickstart

```sh
npm install webmcp-tools zod
```

### Vanilla

```ts
import { tool, getRegisteredTools } from "webmcp-tools";
import "webmcp-tools/zod";
import { z } from "zod";

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

Tool names must be **1–128 characters from `[A-Za-z0-9_.-]`** (the spec constraint) — `tool()` throws on anything else.

> **Zod note:** the `webmcp-tools/zod` adapter uses the **Zod v4 API** via the `zod/v4` subpath, which exists in Zod 3.25+ and Zod 4 — so the full `^3.25.0 || ^4.0.0` peer range works. On Zod 3.25.x, build schemas with `import { z } from "zod/v4"`.

### React

```tsx
import { useWebMCPTool, useRegisteredTools } from "@josharsh/webmcp-react";
import "webmcp-tools/zod";
import { z } from "zod";

function Cart() {
  const [items, setItems] = useState<Item[]>([]);

  useWebMCPTool("clear-cart", {
    description: "Remove every item from the cart",
    confirm: true,
    run() {
      setItems([]);
      return "Cart cleared.";
    },
  });

  const tools = useRegisteredTools(); // live list, re-renders on change
  // ...
}
```

Tools follow the component lifecycle: registered on mount, unregistered on unmount. See [`examples/todo`](./examples/todo) for a complete runnable app with an agent-call simulator.

### Declarative forms

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
import { autoRegisterForms } from "webmcp-tools";
autoRegisterForms(); // registers every form[toolname], watches DOM + attributes
```

Field names and types become the input schema (`email` → `{ type: "string", format: "email" }`, required honored, `toolparamdescription` → property descriptions); executing the tool fills the fields (dispatching `input`/`change` so React/Vue controlled inputs notice). Per the explainer, the form is only **submitted automatically when it has `toolautosubmit`** (or `autoSubmit: true` is passed) — otherwise the submit control is focused and the user reviews and submits manually. `toolname`/`tooldescription`/`toolautosubmit` attribute changes re-register the tool live; removing `toolname` unregisters it. `formTool(form, { confirm, autoSubmit, onSubmit })` gives per-form control.

### DevTools panel

Test your tools without any agent. A zero-dependency floating inspector that
lists registered tools live, generates an input form from each tool's JSON
Schema (flat schemas get real fields; nested ones get a pre-filled JSON
editor), and executes through the same validated path an agent uses —
confirm gates included.

```ts
if (import.meta.env.DEV) {
  const { initDevtools } = await import("webmcp-tools/devtools");
  initDevtools(); // { position: "bottom-left" | "bottom-right" }
}
```

The dynamic import inside a dev-only branch keeps it out of production
bundles entirely.

### MCP bridge (extension / iframe agents)

Native WebMCP only serves browser-built-in agents. The bridge serves everyone else — it exposes the kit's tool registry as a real MCP server over `postMessage`:

```ts
// In the page
import {
  createWebMCPServer,
  PostMessageServerTransport,
} from "@josharsh/webmcp-bridge";

const bridge = createWebMCPServer({ name: "my-app", version: "1.0.0" });
await bridge.connect(
  new PostMessageServerTransport({
    allowedOrigins: ["https://agent.example"], // who may connect — never "*"
  }),
);
// later: bridge.close()
```

An agent in an extension content script or embedding frame connects with an MCP client over the matching `postMessage` transport and gets `tools/list` + `tools/call` — with the kit's validation and confirm gates still enforced in the page. Tools registered or unregistered later are picked up live via `notifications/tools/list_changed`. Tools with `exposedTo` are only served when the connected peer's origin is in the list; calling an unknown (or hidden) tool is a JSON-RPC `InvalidParams` error, so SDK clients see `callTool` reject.

### Ship an agent with your site

Registering tools is half the loop — [`@josharsh/webmcp-agent`](./packages/agent) closes it with an in-page AI agent that discovers and operates those same tools through `document.modelContext`:

```tsx
import { AgentWidget } from "@josharsh/webmcp-agent/react";

<AgentWidget />; // demo() provider by default — zero config, clearly labeled
```

Swap in a real model with `proxy({ url: "/api/agent" })` (key stays server-side behind `createAgentHandler()` from `@josharsh/webmcp-agent/server`) or use the headless `createAgent()` core with your own UI. The agent never imports your app code — every call goes through the same validation and confirm gates native browser agents will hit, so the agent is disposable and the tools remain the standard. See the [package README](./packages/agent/README.md) for providers, theming, and the security model.

## Packages

| Package                                            | What it is                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`webmcp-tools`](./packages/core)                  | Core: `tool()`, validation, confirm gates, registry, ponyfill, declarative forms, Zod adapter |
| [`@josharsh/webmcp-react`](./packages/react)       | React hooks: `useWebMCPTool`, `useRegisteredTools`                                            |
| [`@josharsh/webmcp-vue`](./packages/vue)           | Vue 3 composables tied to component lifecycle                                                 |
| [`@josharsh/webmcp-svelte`](./packages/svelte)     | Svelte helpers tied to component lifecycle                                                    |
| [`@josharsh/webmcp-bridge`](./packages/mcp-bridge) | MCP server bridge over `postMessage` for extension/iframe agents                              |
| [`@josharsh/webmcp-agent`](./packages/agent)       | In-page AI agent that operates the page's tools: headless core, React widget, server proxy    |
| [`@josharsh/webmcp-example-todo`](./examples/todo) | Runnable Vite + React demo (private)                                                          |

## Browser support

| Environment                              | `document.modelContext` | What the kit does                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome 149+ (origin trial enabled)       | Native                  | `tool()` registers on the native host; built-in agents call your tools; confirm gates route through native `requestUserInteraction`                                                               |
| Chrome (no trial), Firefox, Safari, Edge | Missing                 | Ponyfill installed automatically (`missingHost: "ponyfill"`, the default); identical registration semantics; extension/iframe agents reach tools via the bridge or the ponyfill's `executeTool()` |
| SSR / Node (no `document`)               | Missing                 | Registration is a safe no-op (or set `missingHost: "throw"` to fail fast)                                                                                                                         |

Feature-detect with `hasNativeWebMCP()` / `hasWebMCP()`. The ponyfill defines `document.modelContext` as configurable, so a native implementation arriving later can take over.

## Security

Tools are an attack surface — an agent is an untrusted caller influenced by page content, user prompts, and potentially injected instructions. The kit's posture:

- **Validation at the boundary.** Every invocation is validated against the tool's schema _before_ `run` executes — Standard Schema validation for Zod/Valibot/ArkType inputs, structural JSON Schema checks otherwise. Malformed or extra-clever input is rejected with an `isError` result, never thrown into your app.
- **Confirm gates.** `confirm` puts the human back in the loop for destructive or high-stakes actions, the spec's recommended defense against prompt injection driving unwanted tool calls. The handler routes through the native `ModelContextClient` so the browser can pause the agent loop; the fallback is `window.confirm`, and in non-interactive contexts with no handler configured the default is **deny**.
- **`untrustedContentHint`.** Set `untrustedContent: true` on tools whose results echo user-generated content, so agent harnesses can treat the output as data, not instructions (spec `ToolAnnotations`).
- **Origin allowlists in the bridge.** `PostMessageServerTransport` requires an explicit `allowedOrigins` list; messages from any other origin are ignored. Don't ship `"*"`.
- **Scoped exposure.** Tools default to same-origin/built-in-agent visibility; `exposedTo` selectively exposes a tool to listed origins — and the kit **enforces** it. The ponyfill validates each entry at registration (serialized, potentially trustworthy origin — https or http on localhost — else `SecurityError`) and hides non-visible tools from `getTools({ origin })` / `executeTool(…, { origin })` (NotFoundError, no existence leak). The MCP bridge filters `tools/list` and `tools/call` by the connected peer's origin.

## Roadmap

Tracking the spec as it evolves ([open issues](https://github.com/webmachinelearning/webmcp/issues)):

- **`outputSchema`** — structured output contracts alongside `inputSchema`, so agents can reason about return values ([webmcp#9](https://github.com/webmachinelearning/webmcp/issues/9)). The kit already returns `structuredContent`; typed output schemas land when the spec settles.
- **Elicitation / user prompting** — richer mid-tool user authorization than confirm dialogs, building on `ModelContextClient` ([webmcp#165](https://github.com/webmachinelearning/webmcp/issues/165), [webmcp#50](https://github.com/webmachinelearning/webmcp/issues/50)).
- **Service-worker tools** — background tool discovery and invocation for sites the user doesn't have open, per the spec's [Service Workers explainer](https://github.com/webmachinelearning/webmcp/blob/main/docs/service-workers.md).
- More schema adapters (Valibot/ArkType descriptor generation — runtime validation already works via Standard Schema) and devtools for inspecting live tool traffic.

## Contributing

PRs welcome. This is a pnpm workspace:

```sh
pnpm install
pnpm build       # build all packages
pnpm test        # vitest, happy-dom
pnpm typecheck
```

Tests live next to source (`*.test.ts`). Keep dependencies minimal; match the existing code style (Prettier defaults).

## License

[MIT](./LICENSE) © 2026 Harsh
