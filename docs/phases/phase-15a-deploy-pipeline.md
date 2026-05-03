# Phase 15a — Deploy pipeline

**Goal:** end-to-end deploy automation. A user runs `aflare deploy
./project` and the framework picks up new files, pushes them to R2,
re-renders static routes, and atomically flips traffic to the new
deploy. Hybrid serving means deploys cut cold-start latency for
static routes while live SSR remains available for everything
dynamic.

**Status:** done. **574 tests / 51 files / 6 pools all green** (was
550 at end of Phase 15).

## What landed

### Hybrid project-worker serving

`createFetchHandler` now reads `/site/current` from R2 once per
request:

  1. If `/_aflare/deploy*` — handle the deploy endpoints.
  2. Else if `/site/current` exists — try the deploy server first.
     A non-404 response is returned directly; 404 means the deploy
     didn't pre-render this URL, so fall through.
  3. Live SSR via the preview server.

Deployed responses skip HMR client injection; SSR responses keep it
(test-time only — production would normally turn HMR off via
config). The choice happens organically because `createDeployServer`
returns the bytes verbatim and `createPreviewServer` wraps in HMR.

### `/_aflare/deploy` endpoint

`POST /_aflare/deploy` with `Authorization: Bearer <env.DEPLOY_TOKEN>`
runs `deploy({host, runtimeImport})` server-side:

  - Plan every page (static + `getStaticPaths`-expanded dynamic)
  - Compile each route's closure via the `WorkerdExecutor`
  - Render every static route in series (Workflow-orchestrated
    parallelism is a separate, deferred concern)
  - Write the manifest + each rendered HTML under
    `/site/<deployHash>/`
  - Atomically flip `/site/current` to the new hash

Returns `{deployHash, routeCount, skippedCount, durationMs}`.
Deploys are idempotent — two no-op deploys produce the same
`deployHash` (content-addressed off page sources), so re-deploying
the same content is a no-op flip.

`GET /_aflare/deploy/status` returns the active deploy hash with no
auth. The response contains no secrets; it's the same surface
Astro's deploy dashboards would query.

`DEPLOY_TOKEN` lives in `env` as a Worker secret. Tests bind it via
the Miniflare programmatic config; production hosts use
`wrangler secret put DEPLOY_TOKEN`.

### `@astroflare/cli`

New package with the `aflare` binary:

```
aflare deploy [dir]      # Walk project, upload to R2, trigger deploy
aflare status            # GET /_aflare/deploy/status
aflare rollback <hash>   # PUT /site/current → previous hash
```

Configuration resolves from CLI flags > env vars > `aflare.config.json`.
Required: account ID, bucket, API token, worker URL, deploy token.

`deploy` walks `src/` and `public/` from the project root, hashes
every file (SHA-256), HEADs each R2 key to skip upload when the
content metadata matches, and PUTs the changes. Object keys mirror
`R2Storage`'s layout (`files/<workspace-path>`); the SHA hash is
stamped into custom metadata at write time so subsequent stats hit
the metadata fast-path.

Then POST `/_aflare/deploy` with the bearer token; the worker runs
the rendering ceremony and returns the deploy hash. The CLI prints
the result as one-line JSON for scriptability.

`rollback` is intentionally distinct from `deploy` so it isn't a
one-character typo away. It writes the bytes of `<hash>` directly
to the `/site/current` R2 key — no re-render, just a pointer flip.

No third-party deps: only Node stdlib (`fs/promises`, `crypto`,
`fetch`, `util.parseArgs`). 8 unit tests with mocked `fetch`
covering the upload + skip-on-match path, status, rollback, and
config resolution.

### `getSecret` runtime helper

`packages/astroflare-runtime/src/env.ts` — `getSecret(name)` reads
from a per-request `AsyncLocalStorage` slot bound by the project
worker via `withEnvContext(envValuesAsRecord, fn)`. Distinct from
Phase 12's compile-time `import.meta.env` substitution: this is
runtime resolution against bound Worker secrets, never inlined
into compiled artifacts.

7 unit tests cover the surface: scope binding, missing-name
behaviour, propagation across awaits, nested scope shadowing.

### Cross-isolate caveat (deferred)

`getSecret` works for code running in the *parent worker isolate* —
the deploy endpoint, hybrid-serving routing, the preview server's
request scaffolding. User-authored middleware / endpoints / SSR
frontmatter run in Worker Loader-spawned child isolates and don't
share the parent's ALS, so `getSecret` returns `undefined` there.
Threading env values through the JSON-marshaled task context is
the right fix; deferred to a follow-on phase.

### `nodejs_compat` for spawned isolates + DO retry on stub
invalidation

Two production-shape fixes that landed alongside:

  - The `WorkerdExecutor` now sets
    `compatibilityFlags: ["nodejs_compat"]` on spawned child
    isolates so the framework runtime's `node:async_hooks` import
    resolves. Without this, the runtime's `internal.ts` ALS calls
    fail at module-load time (Phase 15 fix; carried forward).
  - `DurableObjectCoordinator` now accepts a stub *factory* (not a
    captured stub) and retries on the workerd "invalidating this
    Durable Object" error, calling the factory to get a fresh stub
    on each retry. Tests that re-load the harness file
    (vitest watch / cold starts) hit this routinely; production
    hits it during deploys. The pattern mirrors `transport.ts`'s
    HMR DO handling.

### Build planner: `.mdx` extension

`outputPathFor` now strips `.mdx` (was `.astro` and `.md` only).
Matches the Phase 14 router + content reader's extension support.

## Numbers

- **574 tests / 51 files / 6 pools** all green.
- 24 new tests since Phase 15:
  - `astroflare-runtime/src/env.test.ts` — 7 unit tests
    (`getSecret` / `withEnvContext` semantics)
  - `astroflare-cli/src/commands/deploy.test.ts` — 8 unit tests
    (config resolution, file walking, mocked deploy/status/rollback)
  - `tests/integration/deploy.test.ts` — 9 integration tests (auth,
    ceremony, hybrid serving, status)
- New pool: `cli`.
- Framework boundary still holds — only `host-cloudflare` and
  `cli` import non-framework deps.

## Surprises

- **Cross-isolate ALS doesn't propagate.** The original
  `getSecret` design called for it to work in middleware /
  endpoints / SSR frontmatter. Those paths run in Worker
  Loader-spawned child isolates. AsyncLocalStorage is process-local
  (or isolate-local in workerd); there's no propagation across
  isolate boundaries. Cleanest fix is threading env values through
  the JSON-marshaled task context, which is more invasive than
  Phase 15a's scope. Documented as a carve-out; the surface stays
  useful for parent-worker code.

- **Middleware/endpoints don't survive Worker Loader marshaling
  either.** Related discovery while debugging the failed
  middleware-getSecret test. The middleware loader returns a
  function from a child isolate via JSON, but JSON.stringify
  drops functions silently. The existing tests pass under
  `InProcessExecutor` (Node tmp-dir, functions survive) but would
  fail under `WorkerdExecutor`. Phase 15a doesn't fix this; the
  whole middleware/endpoint loading approach needs a different
  shape for production. Adding to the Phase 19 quality-gate
  punch-list.

- **DO invalidation surfaces during tests too.** The "invalidating
  this Durable Object" error fires whenever workerd reloads the
  watched harness file — common in vitest watch, common in cold
  starts. The first cut of `DurableObjectCoordinator` captured
  the stub at construction time; retries against a stale stub
  re-throw the same error. Switching to a stub factory closure
  (so retries call `namespace.get(id)` again to get a fresh
  stub) made the integration tests stable.

- **`vars` in `wrangler.toml` ≠ Miniflare bindings.** The first
  attempt at `DEPLOY_TOKEN` set it via `[vars]` in
  `tests/integration/wrangler.toml`. Miniflare's programmatic
  config (used by vitest-pool-workers) doesn't read `[vars]`
  automatically; it expects bindings under `bindings: { ... }` in
  the Miniflare options. Two lines to fix once you know;
  brutal failure mode (auth check returns 401) until you do.

- **Body type mismatches between Node fetch and undici.**
  `Uint8Array<ArrayBufferLike>` (Node 22+ shape) isn't assignable
  to undici's `BodyInit`. Same fix as the Phase 13 R2 issue: copy
  into a fresh `Uint8Array(byteLength)` before passing to
  `fetch`. Or send the body as a string — the deploy hash
  rollback case takes that route.

## What did NOT land in this run (and why)

- **Workflow-orchestrated parallel render fan-out.** The brief's
  §6 / §7.7 call for up to 10k-step parallelism via Cloudflare
  Workflows. Phase 15a renders sequentially. Premature
  optimization until single-render latency budgets bite (which
  Phase 19's quality gates measure). The framework's
  `renderForRoutes` contract — "render this route, write the
  HTML" — is shaped so a parallel implementation slots in
  without touching the framework boundary.

- **Cap'n Web RPC services (`FsService`, `LogService`,
  `ImageService`, `EnvService`).** The brief's §9.3 surface for
  cross-Worker RPC. Phase 15a's project worker is monolithic —
  no separate Bundle DW worker, no agent worker — so the RPC
  surface isn't load-bearing yet. Reconsider when a multi-worker
  topology shows up.

- **`ImageService` production wiring against Cloudflare Images.**
  The interface (Phase 13) exists. Wiring it requires the
  Cloudflare Images binding, which isn't part of the test
  harness. Defer to Phase 15b when the product needs format
  conversion / DPR variants.

- **Cross-isolate `getSecret`.** Documented above. Threading env
  through the task context is its own piece of work; the
  marshaling ABI changes touch every executor caller.

- **Bundle DW + esbuild-wasm pre-bundling.** The deploy ceremony
  currently inline-bundles per-route at deploy time (the same
  path the preview server uses for warm requests). A separate
  Bundle DW worker that pre-builds artifacts would shave cold-
  start latency further but isn't required for correctness.

- **Concurrent deploy lockout.** Two simultaneous
  `POST /_aflare/deploy` calls would both run, both write to
  `/site/current`, last-write-wins. A DO-backed deploy mutex
  would be cleaner; deferred until two-deploys-at-once becomes
  a real failure mode.

- **`aflare init` / project scaffolding.** The CLI doesn't help
  users start a new project — only deploy an existing one.
  Scaffolding via `aflare init` slots in naturally next to
  `deploy` / `status` / `rollback`.

- **CLI watch mode.** `aflare deploy --watch` would re-deploy on
  file changes. Useful for rapid local-edit-deploy cycles. The
  preview server already covers local SSR via HMR; watch-deploy
  would matter for "deploy preview" flows that mirror Cloudflare
  Pages preview deploys. Not Phase 15a.

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm test` — **574 tests across 51 files, all 6 pools green**.
- Framework boundary check — `cloudflare:workers` and
  `@cloudflare/*` imports stay inside `host-cloudflare`. The new
  `@astroflare/cli` package uses only Node stdlib and no
  Cloudflare imports.
- A user can `aflare deploy ./project` against a running project
  worker and see static routes pre-rendered + the deploy hash
  flipped. (Verified end-to-end via the integration deploy
  tests, which exercise the same code path the CLI hits.)

## What the next phase starts from

Phase 16 (hydration runtime + React) inherits a working deploy
pipeline. Per-island client bundles can land in R2 alongside the
SSR-rendered HTML — `<deployHash>/_islands/<chunk-hash>.js` — and
the deploy server already serves arbitrary R2 paths. The hybrid-
serving model means React-hydrated pages still pre-render their
SSR shell from the deploy artifact; the islands fetch their JS
from the same deploy.

Phase 19 (quality gates) inherits the
middleware-doesn't-survive-WorkerdExecutor finding plus the
cross-isolate `getSecret` carve-out. Both want a unified solution
in the executor's marshaling layer. The fix is bigger than a
single phase but smaller than a rewrite — likely a Phase 18-or-19
deliverable.
