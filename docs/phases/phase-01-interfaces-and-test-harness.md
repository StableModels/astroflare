# Phase 1 — Interfaces + in-memory test harness

**Goal (from §7.1 of the brief):** define the five interfaces in
`@astroflare/core`, implement `MemoryStorage`, `MapCoordinator`,
`InProcessExecutor` in `@astroflare/test-utils`, and write the Phase 1 test
suite (storage round-trip, executor cache semantics, coordinator graph + pubsub,
property test for module-graph invalidation).

**Status:** complete.

## What landed

### `@astroflare/core`

- **Six host interfaces** in `src/types.ts`: `Storage`, `Executor`,
  `Coordinator`, `Transport`, `Clock`, `Logger`. (The brief calls it "five
  interfaces" but lists six — `Clock` and `Logger` are bundled.)
- Supporting types: `TaskBundle`, `ModuleNode`, `Subscription`, `HmrMessage`
  (with `update | prune | error | full-reload` variants), `HmrUpdate`,
  `HmrError`, `HmrSocketContext`, `FileStat`, `Host`, `AstroflareApp`,
  `AstroflareConfig` (with `defineConfig()` helper).
- **Content hashing utilities** in `src/hash.ts`: `sha256Hex`, `contentId`
  (truncated to `HASH_ID_LENGTH = 16` per §9.4), `contentIdWithConfig` (mixes
  in a stable transform-config descriptor so a compiler version bump
  invalidates everything), `stableStringify`. Uses Web Crypto, present in both
  Node 22+ and workerd — never reaches for `node:crypto`.
- **Tiny glob matcher** in `src/glob.ts`: `*` (one segment), `**` (any number
  of segments), `?` (one char). Avoids pulling in `picomatch`.
- **App skeleton** in `src/app.ts`: `createApp(config, host)` returns an
  `AstroflareApp` with stub `handlePreviewRequest` (501 until Phase 3),
  `handleHmrUpgrade` (delegates to `host.transport`), and `notifyFileChanged`
  (delegates to `host.coordinator`).
- **Hooks** in `src/hooks.ts`: Astro-shaped names (`astroflare:config:setup`,
  etc.) declared as a string union. Phase 8+ implements.

### `@astroflare/test-utils`

First-class implementations, not stubs (the brief is explicit on this — §7.1,
§12.4):

- **`MemoryStorage`** with disjoint file/cache keyspaces, defensive copies on
  write, content-addressed `stat`, glob via the core matcher.
- **`MapCoordinator`** with reverse-edge bookkeeping in `graphPut` /
  `graphRemove`, transitive-importer walk in `onFileChanged`, EventTarget-style
  pubsub in `publish` / `subscribe`. Subscriber exceptions are swallowed so a
  bad listener can't break fan-out.
- **`InProcessExecutor`** that writes the `TaskBundle.modules` map to a tmp
  directory and `import()`s the main module by `file://` URL.
  - `runOnce` uses a unique tmp dir per call (random suffix) so module
    records never collide.
  - `runCached(id)` uses a tmp dir keyed by `id` and memoises the import
    promise — same id never re-installs or re-evaluates. Different id =
    different dir = different module record.
  - `dispose()` cleans up every dir we created.
- **Stubs** (`StubClock`, `StubLogger`, `MemoryTransport`) and a
  `createTestHost()` helper that returns the full `Host` plus the concrete
  classes (so tests can assert on internals).

### Tests (75 passing)

- **Storage** (15 tests): file round-trip, defensive write copies, cache
  subspace isolation in both directions, glob single-star vs double-star,
  stat hash determinism + change detection.
- **Coordinator** (14 tests): graph CRUD, reverse-edge maintenance through
  edits, pubsub fan-out + unsubscribe + exception isolation, `onFileChanged`
  with `update`/`css` kind, **property test** with 200 random DAGs of 5–24
  nodes verifying the invalidation-set property: every transitively-importing
  module is invalidated.
- **Executor** (10 tests): runOnce isolation (counter remains 1 across calls),
  runCached caches (counter increments), different ids = different isolates,
  factory not called on cache hits, fresh input per cached call, id sanitisation,
  multi-module bundles with relative + nested imports.
- **Hash** (10 tests): SHA-256 known vector, byte/string equivalence,
  `contentId` length, determinism, config-mixing rule (§9.4).
- **Glob** (14 tests): table-driven coverage of every operator combination.

## What surprised me

1. **Reverse-edge bookkeeping is the trickier half of the graph.** Forward
   edges are easy (the caller hands us `imports`); reverse edges have to be
   maintained on every `graphPut`, including when imports *change* (add/remove
   diff). Plus: when a node is removed, downstream `imports` lists must be
   cleaned of the dangling reference. Easy to get wrong, easy to test.

2. **The brief's "fresh isolate" property in tests is achieved by URL-uniqueness,
   not by spawning workers.** Node memoises module imports by URL string. A
   unique tmp dir per `runOnce` call means a unique `file://` URL means a fresh
   module record — exactly the property the brief tests demand. This is
   roughly 50× cheaper than `worker_threads` and skips the message-channel
   marshalling entirely. The trade-off: we get module isolation, not isolate
   isolation, so tests can't assert on shared-global pollution semantics
   (which is fine for Phase 1's scope).

3. **`crypto.subtle.digest` accepts `BufferSource` but TypeScript narrows
   `Uint8Array` to a not-quite-fit type** under strict mode. Cast at the call
   site with `as BufferSource` and document why; alternative is wrapping in a
   `new Uint8Array(buf).buffer`, which copies needlessly.

4. **Biome's `noUnusedTemplateLiteral` rule** flags backtick strings that
   don't use interpolation, even when they were chosen for embedded-newline
   readability. For multi-line template literals it stays out of the way; for
   single-line strings it forces a swap to `"..."`. Mild annoyance, not worth
   disabling.

5. **The brief uses `Storage.glob(pattern): AsyncIterable<string>`.** I
   considered returning a `Promise<string[]>` — simpler — but the streaming
   form is the right call: a workspace glob in production may return many
   thousands of paths, and the consumer often wants to short-circuit. Worth
   keeping the iterable shape; collect-into-array is one helper away.

## Carryovers into Phase 2

- The `Coordinator.onFileChanged` HMR `update.hash` field publishes the *graph
  node's stored hash*, which is the source hash. In a real preview we want the
  *compiled-output hash* (so cache-buster URLs flip when transitively-affected
  imports change). Wiring that up is a Phase 4 concern; right now the
  invariants the brief asks Phase 1 to test (every transitive importer is in
  the set) are correct.
- `AstroflareApp.handlePreviewRequest` returns 501. Phase 3 wires routing +
  compile-via-Executor + render.
- `MemoryTransport.acceptHmrSocket` returns 200 because Node `Response`
  forbids 101. The Cloudflare host's transport will use 101 + `WebSocketPair`
  in workerd; Layer B tests cover that.

## Acceptance signals at phase close

- `pnpm typecheck` — green.
- `pnpm lint` — green.
- `pnpm test` — **75 tests across 13 files, all 4 pools green.**
- Framework boundary check — zero `cloudflare:` / `@cloudflare/` matches in
  framework packages.

## What Phase 2 starts from

- `core` exports the host interfaces and content-id helpers a compiler can
  hash with.
- `test-utils` provides `createTestHost()` so the compiler can be tested with
  `MemoryStorage` + `InProcessExecutor` + `MapCoordinator` from day one.
- The `.astro` parser + emitter is Phase 2's main deliverable; differential
  fixtures land in `compiler/test/fixtures/` next to it.
