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
  postMessage transports (origin-validated, single-peer binding, exposedTo filtering)
- `examples/todo` — Vite+React demo

## Status (2026-06-10)

All review findings (A–H) applied and the full gate is green:
pnpm install / build / typecheck / vitest (163 tests, 0 skipped) /
example build / attw (no problems, node10 green) / npm pack (README+LICENSE
in tarball) / prettier check.

COMMITTED: ee6d547 (review fixes), df28daa (adapters/bridge/tests/example),
ccf29b5 (core). Working tree clean. READY TO PUBLISH — remaining steps are
Harsh's call: create GitHub repo josharsh/webmcp-kit + push; claim @webmcp-kit
npm scope; `pnpm -r publish --access public`.

Fixes applied in ee6d547:

- Packaging: per-condition `types` in exports (.d.cts for CJS), typesVersions
  for core subpaths, peerDeps `workspace:^`, LICENSE copied into all 5
  packages, flagship `packages/core/README.md` written.
- Core: zod adapter imports `zod/v4` (peer range ^3.25 || ^4 now honest);
  tsup external `/^zod($|\/)/`; tool name regex `[A-Za-z0-9_.-]{1,128}`;
  pre-aborted signal returns inert handle (no registry/host zombie);
  host-registration rejection unregisters the tool (ready still rejects);
  `getConfig` exported; `RegisteredTool.exposedTo` surfaced.
- Ponyfill: empty/invalid name + empty description → InvalidStateError;
  exposedTo validated (trustworthy serialized origins, else SecurityError)
  and enforced in getTools/executeTool via `{ origin }` opts (NotFoundError,
  no existence leak); toolchange dispatched via queueMicrotask.
- Bridge: inputSchema normalized to type:"object"; structuredContent only
  for plain objects; unknown tool → McpError InvalidParams (callTool rejects);
  untrustedContentHint preserved in `_meta["webmcp/untrustedContentHint"]`;
  transport binds one peer only after a parsed JSON-RPC message, exposes
  `peerOrigin`, server filters tools/list+call by exposedTo vs peerOrigin.
- Forms: autosubmit only with `toolautosubmit` attr or `autoSubmit: true`
  (else fill + focus submit + "awaiting user review" message);
  `toolparamdescription` (spec) with `tooldescription` fallback on fields;
  autoRegisterForms observes attribute changes and re-registers (rename/
  remove/add toolname). NOTE: handles tracked via expando on the form
  element — happy-dom returns distinct wrappers for the same element across
  querySelectorAll/mutation targets, so element-keyed Maps break there.
- Docs: root README + bridge README synced; core README created.

## Next

1. Commit everything (big batch sitting in working tree).
2. Publish decision is Harsh's (npm org name, GitHub repo creation).

## Notes

- Tooling: pnpm workspaces, tsup, vitest (happy-dom), prettier defaults.
- Spec facts: descriptor = ModelContextTool {name,title?,description,
  inputSchema,execute,annotations{readOnlyHint,untrustedContentHint}};
  options {signal, exposedTo}; toolchange event; native input validation
  NOT in spec (issue #92) — that's the kit's value-add.
- getTools()/executeTool() are spec-TODO; ponyfill implements provisional
  shape, now with `{ origin }` caller-context opts for exposedTo.
- mcp-bridge tests run against core's BUILT dist (workspace dep) — rebuild
  core before trusting bridge test results after core changes.
