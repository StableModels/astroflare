# Phase 0 — Workspace, tooling, CI

**Goal (from §7.0 of the brief):** pnpm workspaces, TypeScript project references,
Vitest, Biome, vitest-pool-workers, Miniflare integration harness, CI lint /
typecheck / test. Get green with placeholder tests in each pool.

**Status:** complete.

## What landed

- pnpm workspaces (`pnpm-workspace.yaml` covers `packages/*`, `examples/*`,
  `tests/*`).
- TypeScript project references — root `tsconfig.json` references each package;
  each package extends `tsconfig.base.json` with strict + composite. `tsc -b`
  is the typecheck entrypoint.
- Biome 1.9 for lint + format. Tab indent, double-quote strings, trailing
  commas, 100-col wrap.
- Vitest workspace with four test pools wired through `vitest.workspace.ts`:
  - **Layer A (node)** — `core`, `compiler`, `runtime`, `preview`, `build`,
    `test-utils` projects.
  - **Layer B (workerd via vitest-pool-workers)** — `host-cloudflare` project.
  - **Layer C (Miniflare via vitest-pool-workers)** — `tests/integration`
    project, with a placeholder Worker entrypoint at `tests/integration/harness.ts`
    that the SSR/preview machinery will replace in Phase 3.
  - **Layer D (differential vs Astro)** lives inside the `compiler` pool when
    its fixtures arrive.
- CI workflow at `.github/workflows/ci.yml` runs lint → typecheck → test on
  push/PR to main.
- `pnpm.onlyBuiltDependencies` whitelists `@biomejs/biome`, `esbuild`, `workerd`
  so postinstall scripts run without a manual `pnpm approve-builds`.
- Phase tracking lives at `docs/phases/`.

## What surprised me (for the next phase's planner)

1. **vitest-pool-workers requires `poolOptions.workers.main` for `SELF.fetch`**
   to work in tests. Without it, the harness boots but `SELF.fetch` throws
   "Using service bindings to the current worker requires `poolOptions.workers.main`".
   Caught immediately when the smoke test ran. Worth writing down: when adding
   a workerd-based test project, point `main` at the worker entrypoint, not
   just the test file.

2. **`@vitest/coverage-v8` is strict about its peer vitest version.** The
   default `^2.1.8` resolves to `2.1.9` for coverage, which then warns about
   peer mismatch with vitest 2.1.8. Pin coverage to the same exact patch as
   vitest. (`vitest-pool-workers@0.5.40` requires vitest 2.1.x, not 2.x.)

3. **Node 22 `Response` rejects status 101** in the constructor — fine in
   workerd because `WebSocketPair` provides the upgrade response, but tests
   that mock a `Transport.acceptHmrSocket` need to use a non-101 status. Worth
   teaching about in the codebase via a comment.

4. **`sharp` shows up as a transitive dep** of wrangler. We skip its install
   script (not in the whitelist), so no native compile happens. The brief
   forbids `sharp` in framework code (§10), and the package boundary (§5.2)
   already prevents framework packages from importing it transitively. Confirm
   periodically that no framework package's resolved deps pull it in.

## Carryovers into Phase 1

None blocking. The interfaces `core/src/types.ts` declares are the next
deliverable.

## Acceptance signals at phase close

- `pnpm typecheck` — green.
- `pnpm lint` — green.
- `pnpm test` — 8 placeholder tests across 4 pools, all green.
- `grep -rE 'from "(cloudflare:|@cloudflare/)' packages/astroflare-{core,compiler,runtime,preview,build}/src` — zero matches (acceptance criterion §11.5).
