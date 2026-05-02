# Phase 7 — Deploy pipeline

**Brief scope (§7.7):** planner / bundle (Bundle DW + esbuild-wasm) / render
fan-out (Workflow-orchestrated) / runtime serving / atomic flip.

**Status:** the framework-side primitives that make the host's deploy
orchestration straightforward to wire up. The Cloudflare-specific pieces —
Bundle DW, esbuild-wasm, Workflows, the Project Worker entrypoint — are
host work, blocked on the same Phase 2.5 finding (no workerd-direct
testing infrastructure yet).

## What landed

### `@astroflare/build` package

Five primitives:

- **`plan(storage)`** — walks `Router.discover`, classifies routes as
  `static` (renderable now) or `skipped` (dynamic routes need
  `getStaticPaths`, deferred). Returns a `BuildPlan` with route counts.
- **`renderForRoutes(plans, opts)`** — for each static route: walk the
  closure via `ModuleGraph` (Phase 4), inline-bundle (Phase 4), run
  through `host.executor.runOnce`, capture HTML, write to
  `/site/<deployHash>/<output-path>`. Sequential per-route; the host can
  swap in a Workflow for parallel fan-out without touching this surface.
- **`buildManifest({…})`, `writeManifest`, `readManifest`** —
  `DeployManifest` format: `{ deployHash, createdAt, routes: [{url,
  source, output, digest}] }` written to
  `/site/<deployHash>/manifest.json`.
- **`flipCurrent(storage, deployHash)`, `readCurrent(storage)`** —
  atomic pointer at `/site/current`.
- **`createDeployServer({host})`** — production-runtime serving shim.
  Reads `/site/current`, looks up
  `/site/<deployHash>/<request-pathname>/index.html`, returns 404 for no
  match, 503 if no current deploy. Phase 8+ adds SSR fall-through.

`deploy({host, runtimeImport})` is the orchestrator: plan →
content-hash all pages → render fan-out → manifest → atomic flip.
Returns `{ deployHash, manifest, rendered, skipped, durationMs }`.

`deployHash` is a content-id over every page's source-content hash. Two
deploys with identical content produce the same hash (deduplicated);
different content produces different hashes (rollback target). Doesn't
yet hash transitive component imports — Phase 7+ when the closure
walker runs during planning.

14 tests cover: plan classification, output-path mapping (`/index.astro`
→ `index.html`, `/about.astro` → `about/index.html`,
`/posts/hello.md` → `posts/hello/index.html`), manifest content,
deploy-server serving with trailing slashes, rolling forward, rolling
back via `flipCurrent` to a previous deploy hash.

### Numbers
- **329 tests / 28 files / 5 pools** all green (was 316 at end of Phase 6).
- 13 new tests, all in the build package.

## Carve-outs

- **Bundle DW + esbuild-wasm** — the brief's bundling phase produces a
  single `WorkerCode`-shaped module map for SSR + per-island client
  chunks. Phase 7 deploys are static-only, so bundling reduces to "the
  inline bundle Phase 4 already produces." When SSR routes land, the
  build needs to bundle SSR closures into a `WorkerCode.modules` map and
  the runtime worker uses Worker Loader to spawn an isolate per request.
- **Workflow-orchestrated parallelism** — `renderForRoutes` is sequential.
  The brief's "up to 10k steps" parallelism lives in the host's deploy
  driver; the framework primitive doesn't change.
- **`getStaticPaths()`** — Tier 0 carryover from Phase 3. Until it lands,
  dynamic routes (`[slug].astro`) are skipped at deploy time.
- **Per-island client bundling** — Phase 8.
- **Deploy-hash content-addressing across transitive imports** — currently
  hashes only page sources. A change to a shared component triggers a new
  deploy hash (because the module-graph closure walker runs during render),
  but two deploys that touch the same components would collide. Phase 7+
  fix: hash the closure key per page during planning.
- **Asset hashing** — static assets in `/public/` aren't yet integrated.
  The shape will be the same content-addressed scheme.
- **Latency assertions** — brief calls for total deploy <30 s on
  Miniflare, <60 s on Cloudflare. Same Phase 2.5 blocker.

## What Phase 8 starts from

- The build pipeline's `deploy()` function is the natural entry point for
  per-island client bundling — once islands exist, the planner emits an
  additional list of `(islandFile, hydrationDirective)` and a parallel
  client-bundling step writes per-island JS into `/site/<deployHash>/`
  alongside HTML.
- `createDeployServer` already does path lookup; serving `.js` islands is
  one more `candidatePaths` entry away.
- SSR routes (Phase 8) plug in via Worker Loader — the host's runtime
  worker holds a `WorkerCode.modules` map and spawns an isolate per
  request; the framework provides the closure-walker output that
  populates it.
