## What

<!-- One or two sentences. Link the issue: Closes #N -->

## Checklist

- [ ] `pnpm -r --filter './packages/*' build && pnpm -r --filter './packages/*' typecheck` pass
- [ ] `pnpm vitest run` green — new behavior has tests that fail without the change
- [ ] `pnpm lint` clean
- [ ] Spec-affecting changes cite the relevant [WebMCP spec](https://github.com/webmachinelearning/webmcp) section/issue
