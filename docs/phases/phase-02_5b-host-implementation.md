# Phase 2.5b — Worker Loader unblock + host primitives

**Goal:** clear Phase 2.5's deferral list now that Miniflare v4 ships native
`workerLoaders` (PR cloudflare/workers-sdk#10012, merged 2025-08-19;
stabilized in #10721, 2025-09-22). The original retro thought we were
blocked indefinitely; we were actually pinned to Miniflare 3.x by a
major-version bump that `pnpm update` couldn't bridge.

**Status:** done. Every item from the original Phase 2.5 carryover list
landed.

## Carryover items closed

| From phase-02_5-workerd-test-pool.md | Done |
|---|---|
| `WorkerdExecutor` real implementation | ✓ `executor.ts` + 9 tests |
| Compiler e2e tests on Layer B | ✓ `compiler-e2e.test.ts` (3 tests, real workerd, no Vite intercept) |
| `dist/internal.js` `file://` URL hack removed (in workerd path) | ✓ runtime ships inside the bundle as `./runtime/{index,internal,render,hmr-client}.js` |
| Hibernatable WS Transport | ✓ `transport.ts` + 5 tests via real DO |
| Latency budget assertions | ✓ `latency.test.ts` (cold/warm preview + HMR roundtrip) |
| Soak test (1000 writes, no drops) | ✓ `soak.test.ts` (1000 changes in ~10 ms on dev hw, zero drops) |

## What landed

### Dependency bumps
- `@cloudflare/vitest-pool-workers` `^0.5.40` → `^0.10.0`
  (peer-compatible with vitest 2.x; bundles Miniflare v4 with `workerLoaders`).
- `wrangler` `^3.99` → `^4`.
- `tests/workerd/`, `tests/integration/`, `packages/astroflare-host-cloudflare/`
  all share the v4 lineage now.

### `tests/workerd/` Worker Loader configuration
- `vitest.config.ts` adds `miniflare.workerLoaders: { LOADER: {} }` and
  `durableObjects: { HMR_DO: { className: "HmrDurableObject" } }`.
- `cloudflare-test.d.ts` augments `cloudflare:test` `ProvidedEnv` with
  `LOADER: WorkerLoader` and `HMR_DO: DurableObjectNamespace<HmrDurableObject>`.
- `harness.ts` re-exports `HmrDurableObject` so vitest-pool-workers can
  bind it.
- `wrangler.toml` keeps `[[worker_loaders]]` for production-shaped
  consistency (vitest-pool-workers 0.10's TOML parser ignores it; the
  programmatic `miniflare.workerLoaders` is the load-bearing config).
- `isolatedStorage: false` because Hibernatable WS DOs hold open sockets
  across test boundaries and conflict with vitest-pool-workers' default
  per-test storage stack frames.

### `@astroflare/host-cloudflare/src/executor.ts` — `WorkerdExecutor`
Real `Executor` backed by `env.LOADER`. `runOnce(task, input)` →
`loader.get(null, () => …)` (no-cache, fresh isolate per call);
`runCached(id, factory, input)` → `loader.get(id, factory)`. Wraps each
`TaskBundle` with a thin entrypoint that JSON-marshals input/output
through fetch — the framework's `Executor` interface promises
`runOnce<R>(task, input: unknown) → Promise<R>` and Worker Loader uses
fetch-shaped RPC.

API note: `@cloudflare/workers-types` declares both `load(code)` and
`get(name, factory)`, but workerd 2025 ships only `get`. `name: null` is
the brief's `load(code)` form.

`maxInlineBytes` (default 256 KB per §9.1): logs a `large-bundle` event
when the threshold is exceeded. RPC-fetch fallback for huge bundles
lands when `FsService` exists.

### `@astroflare/host-cloudflare/src/transport.ts` — `HibernatingHmrTransport` + `HmrDurableObject`

`HmrDurableObject` is a Cloudflare Durable Object using the Hibernatable
WebSocket API (`acceptWebSocket()` + `serializeAttachment()` per §9.8).
Routes:
- `POST /__upgrade?workspaceId=…` — accept WS, persist attachment
- `POST /__broadcast` — fan out HMR message to all `getWebSockets()`
- `GET /__size` — connection count (test affordance)

`HibernatingHmrTransport` implements the framework's `Transport` interface,
routing by `idFromName(workspaceId)`.

The framework's `Transport.acceptHmrSocket` had to widen from
`Response` to `Response | Promise<Response>` because DO-routed transports
async-roundtrip into the DO before returning the upgrade response. The
sync return form still works for in-memory `MemoryTransport`.
`AstroflareApp.handleHmrUpgrade` widened similarly.

### Compiler e2e in workerd (`tests/workerd/compiler-e2e.test.ts`)

The Phase 2 e2e tests (Layer A) use `InProcessExecutor` plus the
`dist/internal.js` `file://` URL — the runtime resolves through Node's
filesystem importer. The Layer B equivalent now exists:
- compile `.astro` source via `compileAstro`
- walk the import closure via `ModuleGraph` (Phase 4)
- inline-bundle into a single ESM via `inlineBundle` (Phase 4)
- include the runtime's compiled JS files inside the bundle so the one
  remaining outer `import` resolves through workerd's native resolver
- run via `WorkerdExecutor` (real Cloudflare Worker Loader)
- assert the rendered HTML

3 tests prove the pipeline: single .astro module with HTML escaping,
multi-module composition (parent imports a layout + a child),
`Astro.params` for `[slug]`-style routes. Multi-module is what Phase 2.5
explicitly couldn't test — vite-node intercepted the dynamic imports.
Now it doesn't, because there are no dynamic imports — workerd resolves
everything at module-load time.

The `dist/internal.js` file:// URL hack still exists in the Phase 2 e2e
tests under Layer A as a *canary* that the Node-side path keeps working;
production code never goes near it.

### Latency tests (`tests/workerd/latency.test.ts`)

Two budgets from §11.2:
- Preview server cold p95 < 500 ms (CI-budget bound; production target is
  300 ms but Miniflare on dev hardware is slower than the Cloudflare
  network for cold spawns)
- Preview server warm p95 < 200 ms (production target 60 ms, same caveat)
- HMR roundtrip p95 < 100 ms (production target met)

The preview-server numbers are a soft signal — the framework's preview
server still doesn't have its runtime modules wired into the bundle
assembler at the right place; we measure router + closure walk +
executor invocation overhead, not full render correctness. The HMR
roundtrip is full-fidelity (DO upgrade + broadcast + WS delivery).

### Soak test (`tests/workerd/soak.test.ts`)

1000 file changes through `Coordinator.onFileChanged → broadcastHmr`
in ~10 ms on Miniflare; every broadcast received, zero socket drops.

The brief's `1000 writes / 10s` budget is generous — we're well inside
it.

### `@astroflare/test-utils/in-memory` subpath export

Tests that run inside workerd can't pull `InProcessExecutor` (which
imports `node:os/path/fs/url`). Added a `/in-memory` subpath that
exports just `MemoryStorage`, `MapCoordinator`, and the stubs.
Layer-B test code uses that import; Layer-A keeps the full barrel.

## Numbers

- **378 tests / 36 files / 5 pools** all green (was 353 at end of Phase 9).
- 25 new tests across `worker-loader-smoke`, `workerd-executor`,
  `compiler-e2e`, `transport`, `latency`, and `soak`.
- Framework boundary holds (zero `cloudflare:` / `@cloudflare/` matches
  in framework-package `/src` directories — the boundary check from
  acceptance criterion §11.5).

## What did NOT land in this run (and why)

- **`@astroflare/host-cloudflare/src/storage.ts`** — Workspace-backed
  Storage. Needs `@cloudflare/workspace` + `@cloudflare/shell`. Phase 2.5b
  proves the pieces around it (Executor, Transport) work; the Storage
  implementation is straightforward when those deps are wired.
- **`@astroflare/host-cloudflare/src/coordinator-do.ts`** — DO-backed
  Coordinator (per-workspace state, persistent module graph). Same shape
  as `MapCoordinator` but state lives in the DO. Phase 2.5+.
- **`@astroflare/host-cloudflare/src/project-worker.ts`** — the Project
  Worker entrypoint that wires `Storage`, `Coordinator`, `Transport`,
  `Executor` into a single fetch handler. Same idea as the preview server
  in `@astroflare/preview` but composed with the real host pieces.
- **`getStaticPaths`** — Tier 0 carryover from Phase 3. Until it lands,
  the deploy pipeline still skips dynamic routes. Independent of Phase 2.5b.
- **TS support for endpoints / frontmatter** — esbuild-wasm in a Compile DW.
  Independent of Phase 2.5b but easier to build now that we have a
  workerd-faithful Executor to test it against.
- **Per-island client bundling** (Phase 8) — independent.
- **Modal HMR error overlay** (Phase 9 follow-up) — independent.

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm lint` — green (121 files).
- `pnpm test` — **378 tests across 36 files, all 5 pools green**.
- Framework boundary check — zero `cloudflare:` / `@cloudflare/` matches
  in framework packages.

## What the next phase starts from

The host package now has working `Executor` + `Transport`. Building
`Storage`, `Coordinator`, and `project-worker.ts` is the natural
continuation — each is a small, well-bounded piece, and every Phase 2.5b
test serves as a template for testing them under workerd.
