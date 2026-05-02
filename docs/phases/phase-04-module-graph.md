# Phase 4 — Module graph + transform-on-demand

**Goal (from §7.4 of the brief):** module graph in `@astroflare/preview/module-graph.ts`,
URL rewriting, transform-on-demand for browser-fetched modules, content-addressed
compile cache via Storage. **The dev-loop heart.**

**Status:** the server-side closure-bundling half landed (the part that
actually unblocks multi-module `.astro` composition). The browser-fetchable
`/_aflare/mod` endpoint is deferred to Phase 5 alongside the HMR client that
will be its primary consumer.

## What landed

### POSIX path utilities (`@astroflare/core/src/path.ts`)

Self-contained. The framework runs in workerd, where `node:path` isn't
available. Just enough for what the framework uses: `dirname`, `joinPath`,
`normalisePath`, `replaceExtension`. 18 tests, table-driven.

### ESM import rewriter (`@astroflare/preview/src/url-rewrite.ts`)

Two regex-based primitives — `extractImports` and `rewriteImports` — that
handle the static and dynamic import shapes the compiler emits and user
frontmatter typically uses. Pure regex; documented edge cases (imports
inside string literals or comments aren't recognised). 13 tests.

### Module graph + closure walker (`@astroflare/preview/src/module-graph.ts`)

Sits on top of `Coordinator`'s graph CRUD (Phase 1). Two operations:

- `compile(path)` — load source from `host.storage`, hash it, look up the
  per-module compile cache (`Storage.cacheRead/cacheWrite` keyed by
  `contentIdWithConfig(source, {compiler, runtimeImport})`). On miss, run
  `compileAstro`, persist. Updates the `Coordinator` graph node with the
  resolved `.astro` import edges. Per-path concurrency lock (in-flight Map)
  so two callers don't double-compile.
- `closure(rootPath)` — DFS the import graph, compile each module, return
  the modules in DFS order plus an aggregate `bundleKey`. The bundleKey is
  a content-id of every module's `path:compileKey` joined and hashed —
  used as `Executor.runCached` id, so a dep change invalidates the cached
  isolate even when the route file itself didn't change.

Two cache layers, both content-addressed:
- per-module compile cache via Storage (survives Coordinator restart, per
  §7.4's brief)
- per-bundle execution cache via Executor.runCached

11 unit tests including diamond-import collapsing, cycle survival, dep-
change cache invalidation, and the brief's required cache-persistence
test (wipe the Coordinator graph, re-request, assert no recompiles).

### Inline bundler (`@astroflare/preview/src/bundle.ts`)

Topologically sorts the closure, emits a single ESM file with one outer
`import` (the runtime) and an IIFE per module. User `.astro` default
imports are rewritten to `const X = __m_<idx>;` references; everything
else gets stripped from each module body.

Why a single inline file rather than a multi-file bundle: vitest's
vite-node loader intercepts dynamic `import()` of tmp-dir files (Phase 2.5
finding) and chokes on nested relative imports. A single file with no
inter-module imports bypasses the issue. Aligns with §9.1 of the brief
("Above ~256 KB, do not inline modules in `WorkerCode`" — below that,
inline is the expected shape).

### Render context propagation via AsyncLocalStorage

Multi-module rendering exposed a runtime gap: child components called via
`$renderComponent(child, props, slots)` had no `Astro` global, because the
framework only constructed one for the root component. Solved by
threading per-request context (`request`, `url`, `params`, `site`)
through `node:async_hooks#AsyncLocalStorage`. `render()` calls
`withRenderContext(ctx, fn)` once at the route level; every nested
`$renderComponent` reads the store and builds a child Astro with shared
context but its own `props`.

The `node:async_hooks` import is in framework code (the runtime). It's
available in Node 22+ and in workerd under `nodejs_compat`, which
Astroflare requires anyway. Not a Cloudflare-specific import — passes the
boundary check in §11.5.

### Preview server multi-module bundling (`preview-server.ts`)

Replaces Phase 3's single-file `buildBundle` with a closure walk through
`ModuleGraph`. The full request path is now:

1. route lookup (Phase 3, unchanged)
2. `ModuleGraph.closure(routeFilePath)` — compile route + every transitive
   `.astro` dep
3. `Executor.runCached(closure.bundleKey, () => buildBundle(modules), ctx)`
4. wrapped in `Response`

Existing Phase 3 tests pass unchanged (single-file is the trivial case).
3 new e2e tests: parent imports layout + button, diamond imports, cache
invalidation when a dep's source changes.

### Numbers

- **268 tests across 23 files**, all 5 pools green (was 223 at end of Phase 3).
- 45 new tests added in this phase: 18 path utilities + 13 url-rewrite +
  11 module graph + 3 multi-module e2e in preview server.

## What surprised me

1. **The runtime ABI had a hidden contract assumption.** Phase 2 / Phase 3
   tests only exercised single-component rendering, where the framework
   builds Astro once and passes it. Multi-module composition exposed that
   `$renderComponent` was bypassing this — child components got `props`
   but no `Astro`. Fix needed runtime work (AsyncLocalStorage), not
   compiler work, but it required knowing the design is "each component
   gets its own Astro built from shared request context + its own props"
   — Astro's actual model. Worth stating explicitly in code comments now.

2. **The vite-node intercept story is subtler than Phase 2.5 documented.**
   Phase 2.5 said "Layer B isn't Vite-free for module loading; only for
   runtime semantics." Phase 4 confirmed: even Layer A `InProcessExecutor`
   is affected when the bundle has nested imports. Single-file bundles
   work; multi-file bundles trigger vite-node's transform path which
   chokes on the imports. Inline bundling is the practical workaround
   *and* aligns with the brief's §9.1 prescription ("inline below 256 KB").
   Not a workaround so much as the right shape that we'd have ended up
   at anyway.

3. **My import-stripping regex used `\w` which doesn't include `$`.** Cost
   me 30 minutes — the runtime symbol names are `$component`, `$render`
   etc., and `[\w*,{}\s]+` didn't match them, so the strip pass left the
   runtime import line in place inside the IIFE. JS `\w` is `[A-Za-z0-9_]`
   only. Lesson: when matching ECMAScript identifiers in regex, use
   `[\w$]` explicitly. Worth checking if the parser tests use names with
   `$` (otherwise we wouldn't catch this in unit tests of the rewriter).

4. **Topological sort + IIFE is essentially what Rollup does.** For a
   moment it felt like cheating ("we said no Rollup, but we're rolling
   our own version"). Then I re-read §10 — "no Vite anywhere; not a
   Rollup-anything" is about not depending on those tools, not about
   never doing the work they do. Hand-rolling a 50-line topo-sort + IIFE
   wrap is fine; pulling in Rollup as a dep is not.

5. **Per-path concurrency lock matters even in test code.** I added it
   defensively, then noticed two of my own tests would have triggered
   double-compile races without it (concurrent `compile(path)` calls
   from `closure(...)` in fixtures with shared deps). The "in-flight Map"
   pattern is a one-liner that prevents a class of bug.

## Carryovers

### Phase 5 (HMR + reactive route discovery)
- The `/_aflare/mod?p=<path>&v=<hash>` endpoint. Originally Phase 4 scope
  per the brief, but its consumers are the HMR client (Phase 5) and
  hydration runtime (Phase 8). Building it now without those consumers
  would mean writing tests against stub clients. Phase 5 builds it
  alongside the HMR client.
- Reactive route discovery: currently routes are cached forever after
  first request. `Coordinator.onFileChanged` for `/src/pages/...`
  invalidates the route table. Same trigger feeds HMR.

### Compiler-side
- Named/namespace imports of `.astro` files (`import { x } from "./Y.astro"`,
  `import * as Y from "./Y.astro"`). Phase 4 only handles default imports
  (which Astro components emit). Astro itself doesn't support named
  exports from `.astro` files, so this is a non-issue for spec compliance
  — but worth flagging if a user writes one, currently silently broken.
- Non-`.astro` imports in user frontmatter (`import { z } from "zod"`,
  `import "./styles.css"`). Phase 4 strips these. Phase 6 handles CSS
  and content-collection schemas; Phase 8 handles `.ts`/`.js` helper
  imports.

### Latency tests
The brief calls for cold/warm latency assertions on Miniflare. Same
blocker as Phase 3: no workerd-compatible Executor yet (Worker Loader
not exposed in Miniflare 3.20250718). Phase 5+ when the host's real
Executor lands.

### `Astro.*` polish
- `Astro.redirect` from a child component returns a Response but the
  framework doesn't currently propagate it to the outer pipeline (the
  child's return value gets `renderToString`-ed). Quick fix — recognise
  `Response` in the render result.

## Acceptance signals at phase close

- `pnpm typecheck` — green.
- `pnpm lint` — green (86 files).
- `pnpm test` — **268 tests across 23 files, all 5 pools green**.
- Framework boundary check — zero `cloudflare:` / `@cloudflare/` matches
  in framework packages.

## What Phase 5 starts from

- Module graph wires multi-file `.astro` projects end-to-end. Phase 5's
  HMR can broadcast per-module updates because the graph already tracks
  reverse edges (the Coordinator's invalidation walk is unchanged from
  Phase 1 — exactly what HMR needs).
- The ALS-based render context propagation is an HMR-invariant — the
  context is built per-request, doesn't survive across requests, so HMR
  invalidation doesn't have to know about it.
- The `bundleKey` is the natural HMR cache-buster: when the closure's
  hash changes, the next request gets a fresh bundle automatically.
  HMR's job is just to nudge the browser to make that next request.
