# webmcp-kit — project state

## What this is

TypeScript monorepo for **webmcp-kit**: typed, validated SDK for WebMCP
(`document.modelContext`, W3C Web ML CG proposal, Chrome 149 origin trial).
Lets websites expose functionality as tools AI agents call directly.
Spec reference clone: /tmp/webmcp-spec (webmachinelearning/webmcp).

## Packages

- `packages/core` → npm `webmcp-kit` — tool() API, schema validation
  (Standard Schema + JSON Schema subset), confirm gates, ponyfill,
  formTool/autoRegisterForms, `webmcp-kit/zod` adapter. WRITTEN BY HAND, committed.
- `packages/react` → `@webmcp-kit/react` — useWebMCPTool/useRegisteredTools
- `packages/vue` → `@webmcp-kit/vue` — composables
- `packages/svelte` → `@webmcp-kit/svelte` — action + store contract
- `packages/mcp-bridge` → `@webmcp-kit/mcp-bridge` — MCP server over
  postMessage transports (origin-validated)
- `examples/todo` — Vite+React demo

## Status (2026-06-10)

- Core: done, builds clean, committed (ccf29b5).
- Adapters/bridge/tests/example: built by workflow wf_593cae0a-8c4
  (implement → verify+fix → adversarial review). Awaiting completion.

## Next

1. Apply review findings from workflow.
2. Final green run: pnpm build/typecheck/vitest + example build.
3. Commit, npm pack dry-run for publishability.
4. Publish decision is Harsh's (npm org name, GitHub repo creation).

## Notes

- Tooling: pnpm workspaces, tsup, vitest (happy-dom), prettier defaults.
- Spec facts: descriptor = ModelContextTool {name,title?,description,
  inputSchema,execute,annotations{readOnlyHint,untrustedContentHint}};
  options {signal, exposedTo}; toolchange event; native input validation
  NOT in spec (issue #92) — that's the kit's value-add.
- getTools()/executeTool() are spec-TODO; ponyfill implements provisional shape.
