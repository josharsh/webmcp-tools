# @webmcp-kit/example-todo

A runnable Vite + React todo app demonstrating [webmcp-kit](../../README.md) end to end:

- Four WebMCP tools registered with `useWebMCPTool` from `@webmcp-kit/react`:
  `add-todo`, `complete-todo`, `delete-todo` (behind a confirm gate), and
  `list-todos` (read-only).
- An **Agent Tools** panel that lists live tools via `useRegisteredTools()`.
- A **Simulate agent call** panel that invokes tools through
  `document.modelContext` (the ponyfill's `executeTool`), so you can watch
  agent-driven UI updates with zero external setup — including validation
  rejections and the `delete-todo` confirm dialog.
- Optional MCP bridge wiring in `src/main.tsx` (flip `ENABLE_MCP_BRIDGE`) to
  expose the tools to an extension or iframe agent over `postMessage`.

## Run it

```sh
pnpm install        # from the repo root
pnpm --filter @webmcp-kit/example-todo dev
```

Then open the printed URL, and use the "Simulate agent call" panel:

1. Pick `add-todo`, invoke with `{ "text": "Buy milk" }` — the list updates.
2. Pick `delete-todo`, invoke with `{ "id": 1 }` — a confirm dialog appears
   before anything is deleted.
3. Send `{ "id": "nope" }` to `complete-todo` — validation rejects it at the
   boundary and the tool body never runs.
