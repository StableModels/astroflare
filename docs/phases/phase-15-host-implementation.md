# Phase 15 — Host implementation (production deploys)

**Goal:** the framework runs end-to-end on real Cloudflare primitives,
not just in-memory test stubs. R2-backed Storage, DO-backed
Coordinator with a persistent module graph, and a project-worker
entrypoint that wires every primitive into a single fetch handler.

**Status:** done. **550 tests / 48 files / 5 pools all green** (was
521 at end of Phase 14).

## What landed

### `R2Storage` (`host-cloudflare/src/r2-storage.ts`)

`Storage` interface implementation backed by Cloudflare R2. Two
keyspaces multiplexed by prefix in a single bucket:

- `files/<workspace-path>` — the user's project tree (leading `/`
  stripped so R2 keys stay POSIX-clean).
- `cache/<sha>` — the content-addressed compile-cache subspace
  (§5.3 of the brief).

Hosts can split into separate buckets via the optional
`cacheBucket` option, but the default keeps `wrangler.toml` minimal
— one binding, two prefixes.

SHA-256 hashes are stamped into R2 object metadata at write time so
`stat` doesn't have to GET the bytes back. Externally-uploaded
objects (e.g. via `wrangler r2 object put` outside the framework)
lack the metadata; `stat` falls back to fetching + hashing for
those. Subsequent stats hit the metadata fast path because we
don't re-PUT.

`glob` extracts the literal prefix before the first wildcard
(`*` / `?` / `[` / `{`) and uses R2 LIST under that prefix, then
post-filters with the framework's `globToRegex`. R2 LIST is
paginated (1k objects/page); the iterator drives pagination via
`cursor` until `truncated: false`.

11 tests under Miniflare's R2 emulation: read/write/remove
round-trips, stat fast-path + fallback, glob with literal prefix
optimization, cache subspace independence, idempotent writes.

### `CoordinatorDurableObject` + `DurableObjectCoordinator` (`coordinator-do.ts`)

Split the framework's `Coordinator` interface across the Worker
boundary:

- **module graph** lives inside the DO (`ctx.storage`-backed,
  sqlite under the hood). One DO per workspace, keyed by
  `idFromName(workspaceId)`.
- **change pipeline** + **pubsub bus** live in the Worker isolate
  via `DurableObjectCoordinator` (the wrapper class). Pubsub
  handlers are JS callbacks — they can't survive RPC, so
  subscribers stay local to the Worker that called `subscribe`.

Cross-Worker fan-out for HMR is the Transport's job, not the
Coordinator's: the project worker calls
`coordinator.subscribe("hmr", msg => transport.broadcastHmr(...))`
once per request, and the Transport DO (Phase 5) handles WebSocket
fan-out across every worker instance with a connected client.

Reverse-edge bookkeeping mirrors `MapCoordinator` — when `imports`
changes on a `graphPut`, the targets' `importedBy` arrays are kept
in sync via `#addImportedBy` / `#removeImportedBy` helpers.
`transitiveImporters` walks the reverse closure inside the DO so
the caller sees a single round-trip.

9 tests cover persistence across stub re-creation, reverse-edge
bookkeeping (add / drop / remove), transitive walks, and the
framework-facing wrapper's pubsub-stays-local contract.

### `project-worker.ts` (`host-cloudflare/src/project-worker.ts`)

Default fetch entrypoint that wires every primitive:

- `Storage` → `R2Storage` over an R2 bucket binding
- `Coordinator` → `DurableObjectCoordinator` over a per-workspace DO
- `Transport` → `HibernatingHmrTransport` over the HMR DO namespace
- `Executor` → `WorkerdExecutor` over Worker Loader, wrapped in
  `RuntimeBundledExecutor` so every spawned isolate carries the
  framework runtime as inlined source
- `clock` → `Date.now()` shim
- `logger` → JSON-line console output (Workers logs / Logpush)

Then routes through `@astroflare/preview`'s `createPreviewServer`.
The "preview" name is historical from Phase 3; in production it's
the live SSR pipeline. The deploy-time bundler (Phase 15a) will
eventually pre-bundle routes for faster cold starts, but the
preview server already does the right thing for warm requests.

`createFetchHandler(opts)` factory + `setProjectWorkerRuntime(map)`
escape hatch let callers plug in the runtime modules at the right
time — the test harness via Vite `?raw` imports, future production
deploys via the deploy-time bundler.

Re-exports `HmrDurableObject` and `CoordinatorDurableObject` so
`wrangler.toml` can name them in `[[durable_objects.bindings]]`
blocks. Without these re-exports wrangler reports
"no class named X is exported by the script" at deploy time.

### The runtime-injection problem (and `RuntimeBundledExecutor`)

The framework's compiled bundles `import` from `runtimeImport`
(e.g. `@astroflare/runtime`). Worker Loader-spawned child isolates
can't resolve npm packages — their module graph is exactly what
we hand them. So `runtimeImport` has to be a key in the spawned
isolate's own module map.

`RuntimeBundledExecutor` wraps `WorkerdExecutor`: every
`TaskBundle.modules` is augmented with the framework runtime files
before the spawn. The default `runtimeImport` is
`./runtime/index.js`, which matches the convention.

The runtime modules themselves come from the caller. The
integration test harness uses Vite's `?raw` imports of the
runtime's dist bundle:

```ts
import RUNTIME_INDEX_SRC from ".../astroflare-runtime/dist/index.js?raw";
// ... internal, render, hmr-client, cookies, components, jsx-runtime
setProjectWorkerRuntime({
  "runtime/index.js": RUNTIME_INDEX_SRC,
  // ...
});
```

Production deploys do the equivalent at deploy time (Phase 15a's
Bundle DW pattern bundles the runtime into the deployed Worker).

### Integration tests (`tests/integration/`)

Layer C (§8.C): full Astroflare assembly under Miniflare against
the real host. Replaced the Phase 0 placeholder smoke test with:

- `smoke.test.ts` — 10 tests covering `.astro`/`.md`/`.mdx` route
  rendering, multi-segment paths, layout composition via
  cross-module imports, cache invalidation on source change,
  `.astro` page importing `{ frontmatter }` from a `.md` file
  (the Phase 14 cross-module hoist working in production
  shape), and asset URL serving
- `r2-storage.test.ts` — 11 unit tests for R2Storage
- `coordinator-do.test.ts` — 9 unit tests for the Coordinator DO

`wrangler.toml` declares the bindings; `vitest.config.ts` mirrors
them in the Miniflare config (compat date 2025-09-01 for Worker
Loader, `nodejs_compat` flag, R2 bucket, two DO classes,
sqlite-classes migration). The harness wires
`setProjectWorkerRuntime` once at module-load time before any
request fires.

## Numbers

- **550 tests / 48 files / 5 pools** all green.
- 29 new tests since Phase 14:
  - `tests/integration/smoke.test.ts` — 10 e2e tests
  - `tests/integration/r2-storage.test.ts` — 11 unit tests
  - `tests/integration/coordinator-do.test.ts` — 9 unit tests
  - (minus the 1 Phase 0 placeholder smoke test)
- Framework boundary still holds — only `host-cloudflare` imports
  `cloudflare:workers`.

## Surprises

- **`nodejs_compat` is required *inside* the spawned isolate, not
  just on the parent.** First attempt at the integration tests
  produced
  `Failed to start Worker: Uncaught Error: No such module
  "node:async_hooks"`. The framework runtime uses
  `node:async_hooks` for per-request context (the
  `AsyncLocalStorage` in `internal.ts` from Phase 5). The parent
  worker's compat flags don't propagate to Worker Loader-spawned
  children — the `WorkerdExecutor` has to set them explicitly. Fix
  was a one-line change in `createHost`:
  `compatibilityFlags: ["nodejs_compat"]` on the
  `WorkerdExecutor` options.

- **The `runtimeImport` URL has to match a key in the bundle's
  module map.** The framework's `runtimeImport` defaulted to
  `"@astroflare/runtime"` since Phase 3, but that npm name doesn't
  resolve inside a child isolate. `RuntimeBundledExecutor` solves
  it by augmenting every `TaskBundle.modules` with the runtime
  files; the default `runtimeImport` becomes `./runtime/index.js`
  for the project worker. The framework's preview server isn't
  affected — its tests use a `file://` URL that the in-process
  executor can resolve directly.

- **DO sqlite migration syntax is the easy thing to forget.** The
  Coordinator DO writes via `ctx.storage.put` (sqlite-backed). Without
  `[[migrations]] new_sqlite_classes = [...]` in `wrangler.toml`,
  Miniflare boots the DO without sqlite and `ctx.storage.put`
  silently goes through the legacy KV path. Tests still pass
  because the legacy path also persists, but production
  performance and tooling differ. Worth being explicit about.

- **The placeholder integration smoke test had been wrong since
  Phase 0.** It asserted `text matches "Phase 0 placeholder"` —
  the right shape until a real harness landed. Phase 15 replaces
  it; the test count drops by 1 from the placeholder removal but
  the integration pool gains 30 new tests on net.

- **`R2Storage.glob` paginates implicitly.** R2 LIST returns 1000
  results per page; the framework's async iterator drives the
  pagination via `cursor` until `truncated: false`. This isn't
  visible to callers — they just `for await` and the right thing
  happens — but it's worth understanding because hosts with very
  large project trees (>1000 files) silently pay an extra LIST
  per glob.

- **Pubsub really does have to stay local.** The first design
  attempt put pubsub in the DO so cross-Worker subscribers would
  see updates. The handler is a JS function, which doesn't
  serialize across DO RPC. The Transport DO already handles
  cross-Worker fan-out for HMR (the only published channel
  currently used); other channels (deploy progress, log streaming)
  would need their own DO if they need cross-Worker fan-out.
  Subscribers staying local means a single Worker invocation's
  subscribers get their events, which is exactly what the preview
  server needs.

## What did NOT land in this run (and why)

- **Cap'n Web RPC services (`FsService`, `LogService`,
  `ImageService`, `EnvService`).** The plan's §9.3 surface — RPC
  classes other Workers can call into for filesystem / log /
  image / env operations. Phase 15 doesn't need them: the project
  worker calls Host primitives directly via in-Worker references.
  Cross-worker RPC matters when there are multiple Workers
  (Bundle DW, agent worker), which is Phase 15a + future.

- **Bundle DW + esbuild-wasm deploy pipeline.** The §11.3
  acceptance criterion — "minimal-blog deploy under 30 s on
  Miniflare" — was the gating criterion for production deploys.
  It needs a separate Workflow-orchestrated worker that bundles
  routes at deploy time and uploads to a Worker. Substantial
  work; the inline-bundle path the project worker uses today is
  the warm-request path, which is already fast. Deploys are
  currently "ad-hoc" — the user populates R2 manually (or via a
  deploy script) and the project worker serves from there. Phase
  15a tracks the formal deploy pipeline.

- **Workflow-orchestrated parallel render fan-out.** The brief's
  §6 mentions parallel SSR fan-out via Workflows. Premature
  optimization until single-render latency budgets are tight.
  Phase 19 (quality gates) measures latency; if it bites, this
  comes back.

- **`@cloudflare/workspace` and `@cloudflare/shell` (the brief's
  package names).** These appear in the brief as proposed
  abstractions; the actual packages either don't exist or aren't
  yet stable. R2 + DOs + Worker Loader cover the ground we need
  for Phase 15. If those packages eventually land, they slot into
  the Storage / Executor surfaces without changing the framework.

- **`ImageService` production wiring.** Phase 13's interface
  exists; wiring it to the Cloudflare Images binding is Phase
  15a. The integration tests use the preview server's stock
  asset URL (`/_aflare/asset/<path>`) which serves R2 bytes
  directly — fine for arbitrary assets, doesn't yet do format
  conversion / DPR variants.

- **`EnvService` runtime helpers (`getSecret(name)` etc.).**
  Phase 12 carryover. The compile-time `import.meta.env`
  substitution lands in compiled bundles already; runtime
  resolution against bound `env.*` secrets is Phase 15a.

- **Persistent graph hash. The Coordinator DO stores nodes
  forever right now.** Hosts that rotate workspaces accumulate
  state. A TTL pass / GC sweep fits naturally as a scheduled
  task; deferred until a host actually feels the pain.

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm test` — **550 tests across 48 files, all 5 pools green**.
- Framework boundary check — `cloudflare:workers` and
  `@cloudflare/*` imports stay inside `host-cloudflare`. No
  contamination of `core`/`compiler`/`runtime`/`preview`/
  `content`/`build`/`test-utils`.
- Integration tests prove the project worker boots end-to-end
  against R2 + DOs + Worker Loader and serves `.astro`/`.md`/
  `.mdx` routes correctly. Cross-module named imports (Phase 14's
  hoist work) verified in the production-shaped host.
- Acceptance §11.5 (framework boundary): `host-cloudflare` is the
  only package importing Cloudflare APIs.
- §11.2/3 latency budgets — measurable but not asserted in CI yet
  (Phase 19 wires the assertions).

## What the next phase starts from

Phase 16 (hydration runtime + React) inherits a fully-wired
production host. Hydration entry points + per-island bundles can
ride on the same R2 storage layout (a new `_islands/` prefix);
the project worker already serves arbitrary R2 paths via the
asset route. The JSX runtime from Phase 14 covers SSR; Phase 16
extends it (or aliases the import) for client-side hydration.

Phase 15a (the deploy pipeline / Bundle DW) is a parallel track
with no Phase 16 dependency — they can land in either order. The
Bundle DW would write to the same R2 bucket the project worker
already reads from, so the integration is just "populate R2 from
a different code path."
