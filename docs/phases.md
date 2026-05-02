# Phase tracker

Each phase ends with a green test suite, a demo, and a written retrospective.
The retrospective informs the next phase's planner.

## Phase 0 — Repo, tooling, CI

**Status:** done.

- pnpm workspaces + TypeScript project references + Vitest + Biome.
- CI workflow lints, typechecks, and runs the full test suite on every PR.
- Per-package `tsconfig.json` extends `tsconfig.base.json`; root `tsconfig.json`
  references each package so `tsc -b` builds the whole workspace.

**Deferred to a later iteration:**

- `vitest-pool-workers` (Layer B host tests against workerd).
- Miniflare integration test harness (Layer C end-to-end).
- These come online when `@astroflare/host-cloudflare` gains substantive code
  to test (currently just an entrypoint stub).

**Retrospective notes for Phase 1:** the framework boundary is asserted via a
grep-based test rather than an import-graph linter — cheap, robust, and matches
acceptance criterion #5 in the brief.

## Phase 1 — Host capability interfaces + in-memory substrate

**Status:** done.

Delivered:

- `@astroflare/core/src/types.ts`: the five interfaces (Storage, Executor,
  Coordinator, Transport, Clock) plus Logger, Host, AstroflareConfig, ModuleNode,
  HmrMessage, Subscription.
- `@astroflare/core/src/app.ts`: `createApp({ config, host }) -> AstroflareApp`.
  `app.fetch()` is a 501 stub until Phase 3.
- `@astroflare/core/src/hash.ts`: `contentHash`, `combinedHash` (SHA-256 hex
  truncated to 16 chars per §9.4 of the brief).
- `@astroflare/preview/src/module-graph.ts`: `ModuleGraph` with `set`, `get`,
  `delete`, `invalidate`, `audit`. Tombstones nodes that still have importers
  (so a deleted dep correctly invalidates its importers); GCs orphan
  placeholders.
- `@astroflare/test-utils`: `MemoryStorage`, `MapCoordinator`,
  `InProcessExecutor`, `FixedClock`, `CapturingLogger`, `NullTransport`,
  `createTestHost()`.

**Tests (Layer A only — Layer B/C land with Phase 3):**

- `memory-storage.test.ts`: 7 tests — round-trip, ENOENT, stat hash stability,
  cache subspace isolation, glob (`*`, `**`, `{a,b}`).
- `map-coordinator.test.ts`: 7 tests — graph CRUD, pub/sub fan-out,
  unsubscribe, file-change broadcasts the correct invalidation set.
- `inproc-executor.test.ts`: 10 tests — runOnce, virtual require for
  sub-modules, runCached factory invocation count, isolate freshness, error
  propagation, async tasks, default/run export shapes.
- `module-graph.test.ts`: 6 unit + 4 property tests over random edit sequences;
  asserts `audit() === []` after every edit and that `invalidate(target)`
  matches a reference reverse-edge BFS.
- `boundary.test.ts`: greps the framework src trees for `cloudflare:` and
  `@cloudflare/` imports; both must be empty.
- `app.test.ts`: createApp + integration hook execution + contentHash sanity.

**Surprises that informed the design:**

- A naïve `delete(path)` that fully drops the node loses back-edges from
  importers, so `invalidate(path)` after a delete returns `{}` instead of the
  importer closure. The fix is to tombstone nodes that still have importers.
- A symmetric problem in `set`: when a node drops a dep, the dep's placeholder
  becomes orphaned and shows up as a stray node in the graph. The fix is to GC
  uncompiled placeholders whose importer count hits zero. Property tests caught
  both, which is exactly what they're for.

## Phase 2 — `.astro` compiler

**Status:** not started. Plan per the brief:

- Pure-JS parser and emitter for `.astro` (no Vite, no Rollup).
- esbuild-wasm for type-stripping the frontmatter.
- Output ABI: default export of a `(result, props, slots) => RenderResult`
  function — must match Astro's runtime contract.
- Tier 0 grammar coverage. Snapshot tests over a hand-written corpus + ported
  Astro fixtures where licensing allows.

## Phases 3 – 9

See the design brief, §7. Each phase ends with green tests on both hosts,
a demo, and a retrospective in this file.
