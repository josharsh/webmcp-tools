# Contributing to webmcp-tools

Thanks for your interest! This is a young project tracking a moving W3C
proposal — contributions that track spec changes are especially welcome.

## Setup

```bash
pnpm install
pnpm -r --filter './packages/*' build
pnpm vitest run        # 163+ tests, happy-dom
```

## Repo layout

- `packages/core` — npm `webmcp-tools`: `tool()`, validation, ponyfill, forms
- `packages/react|vue|svelte` — framework adapters
- `packages/mcp-bridge` — MCP server bridge over postMessage
- `examples/todo` — runnable demo (`pnpm --filter @josharsh/webmcp-example-todo dev`)

## Ground rules

- The WebMCP spec (https://github.com/webmachinelearning/webmcp) is the
  source of truth for `ModelContext*` semantics. Cite the spec section in
  PRs that change ponyfill or descriptor behavior.
- Tests are colocated (`src/*.test.ts`) and must actually catch bugs —
  test failure paths, not just happy paths.
- TypeScript strict; Prettier defaults (`pnpm format`).
- Keep dependencies minimal. The core package has zero runtime deps.

## Before opening a PR

```bash
pnpm -r --filter './packages/*' build && \
pnpm -r --filter './packages/*' typecheck && \
pnpm vitest run && pnpm lint
```

All four must be green. CI runs the same plus `attw` type-resolution checks.
