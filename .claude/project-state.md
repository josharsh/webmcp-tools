# webmcp-tools — project state

## What this is

TypeScript monorepo for **webmcp-tools**: typed, validated SDK for WebMCP
(`document.modelContext`, W3C Web ML CG proposal, Chrome 149 origin trial).
Lets websites expose functionality as tools AI agents call directly.
Spec reference clone: /tmp/webmcp-spec (webmachinelearning/webmcp).

## Packages

- `packages/core` → npm `webmcp-tools` — tool() API, schema validation
  (Standard Schema + JSON Schema subset), confirm gates, ponyfill,
  formTool/autoRegisterForms, `webmcp-tools/zod` adapter. WRITTEN BY HAND, committed.
- `packages/react` → `@josharsh/webmcp-react` — useWebMCPTool/useRegisteredTools
- `packages/vue` → `@josharsh/webmcp-vue` — composables
- `packages/svelte` → `@josharsh/webmcp-svelte` — action + store contract
- `packages/mcp-bridge` → `@josharsh/webmcp-bridge` — MCP server over
  postMessage transports (origin-validated, single-peer binding, exposedTo filtering)
- `examples/todo` — Vite+React demo

## Status update (2026-06-11): @josharsh/webmcp-agent PUBLISHED

- npm: @josharsh/webmcp-agent@0.1.0 (headless core zero-deps, ./react widget,
  ./server handler). Built via 5-phase workflow (ideate x4 lenses, design
  synthesis -> DESIGN.md, implement, verify, adversarial review), then 10
  review fixes (4 majors: abort race/dangling tool_use, body-cap on chunked
  uploads, CORS for allowedOrigins, untrustedByDefault injection hardening).
- 306 tests green across repo. Verified from live registry (core+server load,
  peerDeps ^0.1.0). Committed + pushed.
- Providers: anthropic (raw fetch SSE), proxy (same wire, key server-side),
  builtin (Chrome Prompt API, experimental), demo (deterministic, zero config).
- examples/todo now embeds <WebMCPAgent /> with demo() provider.

## Status (2026-06-10)

All review findings (A–H) applied and the full gate is green:
pnpm install / build / typecheck / vitest (163 tests, 0 skipped) /
example build / attw (no problems, node10 green) / npm pack (README+LICENSE
in tarball) / prettier check.

COMMITTED: ee6d547 (review fixes), df28daa (adapters/bridge/tests/example),
ccf29b5 (core). Working tree clean. PUBLISHED 2026-06-10:

- npm: webmcp-tools@0.1.0, @josharsh/webmcp-{react,vue,svelte,bridge}@0.1.0
  (name webmcp-kit was taken by victorhuangwq's active package — narrower
  scope than ours: no framework adapters, no MCP bridge, no declarative forms)
- GitHub: https://github.com/josharsh/webmcp-tools (public, CI green node 20/22)
- Verified: tarball smoke test (ESM+CJS, full agent path) + live registry
  install of core+react adapter. peerDeps correctly rewritten to ^0.1.0.

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

## Security review fixes — packages/agent (2026-06-11)

All 10 verified security-review findings fixed, full gate green
(build / typecheck / vitest 306 tests 0 skipped / attw all green / prettier):

- agent.ts: abort race after stream end now pushes synthetic tool_results
  for dangling tool_use (no more Anthropic 400 on next send);
  `untrustedByDefault` AgentOption (tools without explicit
  untrustedContentHint:false get wrapped + taint); caller AbortSignal
  listener removed in send() finally; max-tokens with no calls → notice
  "Response was cut off at the token limit."
- server/handler.ts: maxBodyBytes enforced WHILE reading (chunked bodies
  bounded, 413 early); toNodeHandler takes { maxBodyBytes } and destroys
  oversized requests; CORS implemented for allowedOrigins array/"any"
  (preflight 204, ACAO = validated origin echo, Vary: Origin on all
  responses incl. SSE/errors; same-origin default unchanged, OPTIONS 405);
  toNodeHandler honors res.write() backpressure (awaits 'drain').
- providers/wire.ts: unparseable tool input deferred — dropped (not thrown)
  when stop_reason is max_tokens; still throws otherwise.
- providers/anthropic.ts: browser detection also catches Web/Service
  Workers (globalThis.importScripts heuristic).
- DESIGN.md: tools-changed event, ProviderToolDescriptor.title,
  nextAppRoute/toNodeHandler + CORS/body-cap behavior, untrustedByDefault.
- README.md: untrustedContentHint-keyed defenses + untrustedByDefault
  recommendation; CORS + body-limit docs for createAgentHandler.

NOTE: node_modules vanished mid-session; reran pnpm install (lockfile
unchanged). Agent package NOT yet published (0.1.0 unreleased).

## Next

1. Commit everything (big batch sitting in working tree — includes all
   security fixes above; repo dir currently shows as non-git here, verify).
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
