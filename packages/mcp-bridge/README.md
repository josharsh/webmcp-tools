# @josharsh/webmcp-bridge

Expose the tools your page registered with [`webmcp-tools`](https://github.com/josharsh/webmcp-tools) as a **real MCP server**, so external agents — browser extensions, iframe agents, devtools — can `tools/list` and `tools/call` them over `window.postMessage`.

The bridge mirrors the kit registry live: tool registrations and unregistrations are pushed to connected agents as `notifications/tools/list_changed`, and every call runs the tool's full pipeline (schema validation, confirm gate, result normalization).

## Install

```sh
npm install webmcp-tools @josharsh/webmcp-bridge
```

## In the page (server side)

```ts
import { tool } from "webmcp-tools";
import {
  createWebMCPServer,
  PostMessageServerTransport,
} from "@josharsh/webmcp-bridge";

tool("add-to-cart", {
  description: "Add a product to the shopping cart",
  input: {
    type: "object",
    properties: { sku: { type: "string" } },
    required: ["sku"],
  },
  run: ({ sku }) => cart.add(String(sku)),
});

const bridge = createWebMCPServer({ name: "my-shop", version: "1.0.0" });
await bridge.connect(
  new PostMessageServerTransport({
    // Only these origins may list/call your tools. Pass ["*"] explicitly
    // (and knowingly) to accept any origin.
    allowedOrigins: ["https://agent.example"],
  }),
);
```

## In the agent (client side — extension content script, iframe, devtools)

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PostMessageClientTransport } from "@josharsh/webmcp-bridge";

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(
  new PostMessageClientTransport({
    target: pageWindow, // e.g. an iframe's contentWindow, or window itself
    targetOrigin: "https://shop.example",
  }),
);

const { tools } = await client.listTools();
const result = await client.callTool({
  name: "add-to-cart",
  arguments: { sku: "SKU-1" },
});
```

## API

| Export                       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createWebMCPServer(opts?)`  | Build an MCP server backed by the kit registry. `opts`: `{ name?, version? }`. Returns `{ server, connect(transport), close() }`.                                                                                                                                                                                                                                                                                                                    |
| `WebMCPBridgeServer`         | Return type of `createWebMCPServer`. `server` is the raw SDK `Server` for custom handlers.                                                                                                                                                                                                                                                                                                                                                           |
| `PostMessageServerTransport` | `new (opts: { window?, allowedOrigins, channel? })`. Listens for client messages; **rejects any origin not explicitly in `allowedOrigins`**, binds exactly one peer (the `{source, origin}` of the first valid JSON-RPC message — later messages from other sources/origins are ignored), exposes the bound origin as `peerOrigin`, and replies to the bound `event.source` targeting its origin (never a wildcard when a concrete origin is known). |
| `PostMessageClientTransport` | `new (opts: { target, targetOrigin, channel? })`. Connects an SDK `Client` to a page's bridge; only consumes replies from `targetOrigin`.                                                                                                                                                                                                                                                                                                            |
| `DEFAULT_CHANNEL`            | `"webmcp-tools-mcp"` — the default envelope channel. Both peers must use the same channel.                                                                                                                                                                                                                                                                                                                                                             |

### Semantics

- **`exposedTo` filtering.** Tools registered with `exposedTo: [origins]` are only served (in `tools/list` and `tools/call`) when the transport's bound `peerOrigin` is in the list. Tools without `exposedTo` are served to every connected peer. Hidden tools are indistinguishable from unknown ones.
- **Unknown tools are JSON-RPC errors.** `tools/call` with an unknown (or hidden) name responds with an `InvalidParams` JSON-RPC error — SDK clients see `client.callTool(...)` reject. Tool _execution_ failures (validation, declined confirm, thrown `run`) still come back as `isError` results.
- **`untrustedContentHint` rides in `_meta`.** The MCP SDK's annotations schema strips the WebMCP-specific `untrustedContentHint`; the bridge preserves it as `tool._meta["webmcp/untrustedContentHint"]` (`readOnlyHint` stays in `annotations`).

### Wire format

Messages are wrapped as `{ channel, side: "client" | "server", message: <JSON-RPC> }` and everything else on the window is ignored. The `side` tag lets both peers share a single window (devtools, tests) without consuming their own traffic; the `channel` lets multiple bridges coexist.

## License

MIT
