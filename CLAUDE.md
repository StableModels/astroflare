# CLAUDE.md — agent runbook

Concise pointers for working in this repo. **The code is authoritative.**
When this file disagrees with reality, fix the file in the same change
that touched the code.

## How to use this file

- Read it at session start. It's the index, not the manual.
- It links to authoritative sources (specs, retros, code) — follow the
  links rather than duplicating their content here.
- When you change behavior that this file describes (e.g. add a CLI
  verb, change a test layer), update this file in the same commit. If
  you wouldn't update it, you're probably not touching the things it
  describes — move on.
- If something here is stale, fix it. Don't work around it.

## Architectural North Star — framework, not app

Astroflare is a **library**. The host brings everything stateful:
filesystem, Durable Objects, Worker entrypoint, lifecycle.
Astroflare receives capabilities (`Site`, `Executor`, `Cache`) and
runs framework logic over them. It may ship convenience helpers,
but never *is* the app.

Concretely:
- **Zero Astroflare-owned DO classes.** The host's DO holds state;
  Astroflare provides factories the host calls inside its DO
  constructor.
- **Zero canonical worker entrypoint.** The host writes its
  worker; Astroflare provides request-handler factories.
- **Storage is host-supplied** through the narrow `Site` interface.
  Filesystem adapters live in `@astroflare/host-cloudflare` (the
  one Cloudflare-touching package) so the framework core doesn't
  import `@cloudflare/shell`, R2 bindings, etc.
- **Astroflare-internal state** (module graph, compile cache)
  lives in the host's sqlite under the `aflare_*` table prefix.

Guardrail when adding code: if a change makes Astroflare own a
binding, a DO, a worker entrypoint, or runtime lifecycle, push it
across the boundary into the host. Mode B's **build** step is a
library function (`buildSite`) the host invokes — exempt from the
runtime-ownership rules; runs from anywhere (local, CI, in-Worker)
via the `Executor` abstraction. Mode B's **serve** step is a worker,
fully subject to the rules: Astroflare ships a request-handler
factory and an `R2Snapshots` adapter, never the worker entrypoint;
the host owns the worker, the storage binding, and the path layout.

### Hard rule: every shipped path must run on a Cloudflare Worker

Workers-runnable-only is a load-bearing constraint, not a soft
preference. When the choice is between a richer dependency that
can't run on a Worker and a thinner one that can, we ship only the
thinner one — and we don't expose the incompatible path even as an
opt-in. Concretely:

- **No runtime `WebAssembly.instantiate()`** of arbitrary bytes.
  Workers blocks it (`Wasm code generation disallowed by embedder`).
  Only modules statically declared in `wrangler.toml`'s
  `[wasm_modules]` execute, and Astroflare doesn't ship any.
- **No `node:*` imports** in any package that loads inside a
  Worker (`@astroflare/build`, `@astroflare/host-cloudflare`,
  `@astroflare/runtime`, `@astroflare/preview`,
  `@astroflare/compiler`). The Node-only build pipeline at
  `@astroflare/build/node` is the lone exception, scoped to local
  CLI / CI use.
- **No native bindings, no Vite, no `esbuild` native.** Bundling and
  syntax stripping use pure-JS primitives only — `sucrase` for the
  compiler's TS-strip pass (`packages/compiler/src/ts.ts`),
  `acorn` + `acorn-jsx` for the `.astro` body-expression brace
  finder (`packages/compiler/src/astro/parser.ts`), Shiki's
  pure-JS regex engine for highlighting. (`§10` of the founding spec.)
  `esbuild-wasm` is forbidden in any Worker-loaded path: it calls
  `WebAssembly.instantiate()` at `initialize()` time, which Workers
  blocks.
- **No configuration option exposes a Worker-incompatible path**,
  even gated behind a flag. Examples: Shiki's WASM regex engine
  (Oniguruma) is more accurate but can't run on a Worker, so the
  compiler wires Shiki's pure-JS engine unconditionally; the
  Oniguruma path is not user-selectable. Same shape for TS syntax
  stripping — `transformTS` is sucrase-only; the previous
  `esbuild-wasm` path was removed when embedders hit
  `Wasm code generation disallowed by embedder` on any frontmatter
  carrying `interface Props { ... }`.

Guardrail when adding a dependency: try to run it inside a Worker
(`workerd` test pool, miniflare, or a real preview deploy) before
shipping. If it needs `node:*` shimming, dynamic WASM, or a build-
time hack only Node provides, find a different dependency or write
the path yourself.

### Hard rule: no leaf-package devDeps that hosts runtime-depend on

`react`, `react-dom`, `vue`, `svelte`, `solid-js`, `preact` —
anything a host application is likely to bundle into its own
runtime — must live in the **root** `package.json`'s
`devDependencies`, never in `packages/*/package.json`. Workspace
embedders (Ember-style monorepos that vendor `packages/*` directly)
treat leaf devDeps as workspace-level constraints; an exact pin
(`"react": "18.3.1"`) on a leaf package displaces the host's own
React resolution and produces duplicate-React bundles (minified
React error #525 at render time). Root-level devDeps are treated
as the monorepo's own dev tooling and don't propagate that way.

Enforced by [`tests/repo/no-leaf-host-runtime-deps.test.ts`](tests/repo/no-leaf-host-runtime-deps.test.ts).
When a leaf-package test legitimately needs one of these names,
move the test to a project under `tests/<name>/` so the metadata
stays out of the leaf's `package.json`.
**Status (post-Phase 26 / 26b / 26c finalization):** the public
host API surface is fully aligned. Hosts write their own
`SiteDurableObject` (Mode A) or deploy worker (Mode B); they
import `createCoordinator` / `createPreviewHandler` /
`acceptHmrSocket` / `SqlCache` / `createWorkerdExecutor` /
`WorkspaceSite` from `@astroflare/host-cloudflare` (Mode A);
`createSnapshotHandler` from `@astroflare/build` and `R2Snapshots`
/ `R2SnapshotSink` from `@astroflare/host-cloudflare` (Mode B). The legacy
`stack-worker.ts`, `project-worker.ts`, `R2Storage`,
`CoordinatorDurableObject`, `HmrDurableObject`,
`createDeployServer`, and the `deploy()` build function are all
gone. Reference fixtures
([`tests/e2e/fixtures/preview-host-ref/`](tests/e2e/fixtures/preview-host-ref/),
[`tests/e2e/fixtures/deploy-host-ref/`](tests/e2e/fixtures/deploy-host-ref/))
build cleanly into deployable bundles.

**Embedding-friendly additions (post-26c):**
- `@astroflare/build` (workers-safe entry) now exports `buildSite`
  alongside `createSnapshotHandler`. The Workers-runtime version
  takes a `Site` + `Executor` and yields `SnapshotEntry`s callers
  pipe into a `SnapshotSink` — same streaming shape as the Node
  version, no `node:*` imports. Lets hosts pre-render snapshots
  to R2 from inside a Worker (Ember and other Worker-runtime
  consumers). The Node version stays at `@astroflare/build/node`.
  Dynamic `[slug]` routes are enumerated through the route's
  `getStaticPaths()` export (one snapshot entry per declared
  `{ params, props }` pair), so the snapshot pipeline and
  `createPreviewHandler` agree on what the source tree contains —
  preview and publish stay in lock-step.
- `@astroflare/host-cloudflare/runtime-modules` ships a pre-inlined
  `runtimeModules: Record<string, string>` for
  `createWorkerdExecutor({ runtime })`. Bundler-agnostic; replaces
  the `__AFLARE_RUNTIME_MODULES__` global-substitution pattern as
  the recommended path. The generator script
  (`packages/host-cloudflare/scripts/generate-runtime-modules.mjs`)
  runs as part of `pnpm build`; CI checks the generated file is
  up to date.
- `@astroflare/starter` is the canonical project scaffold. Two
  byte-identical consumption modes: `getStarterFiles()` for
  in-Worker materialisation, `writeStarterFiles({ dir })`
  (or `af new <dir>`) for on-disk. The `template/` directory is
  the source of truth; `scripts/generate-starter-files.mjs`
  inlines it as base64 into `src/starter-files.generated.ts`,
  also part of `pnpm build`.
- `buildRenderTask` / `buildClosureRenderTask` (in
  `@astroflare/build`) are the shared shims that wrap compiled
  `.astro` route code into a `TaskBundle` for the executor.
  `buildClosureRenderTask` is the multi-module shape used after
  `inlineBundle` flattens an import closure; both
  `createPreviewHandler` and `buildSite` (workers) walk the closure
  via `ModuleGraph` (re-exported from `@astroflare/preview/module-graph`)
  so layouts, shared components, and `.md`/`.mdx` deps end up in the
  bundle alongside the route.

Phase plans:
[`docs/phases/phase-26-host-driven-preview.md`](docs/phases/phase-26-host-driven-preview.md),
[`docs/phases/phase-26b-host-driven-build.md`](docs/phases/phase-26b-host-driven-build.md),
[`docs/phases/phase-26c-agent-ops-cli.md`](docs/phases/phase-26c-agent-ops-cli.md).

## Project shape

Astroflare is an Astro-compatible content framework that runs on
Cloudflare's isolate primitives. Two lifecycles:

- **Mode A — Preview / in-Worker compile + render.** Host-driven
  (Phase 26). The host application writes a `SiteDurableObject` that
  owns a `@cloudflare/shell` `Workspace` + Astroflare's coordinator
  (`createCoordinator`) + the HMR endpoint. The host's worker calls
  `createPreviewHandler` to render. Astroflare ships zero DOs and
  zero entrypoints. *Requires the paid Workers plan* (Worker
  Loader binding). Reference fixture:
  [`tests/e2e/fixtures/preview-host-ref/`](tests/e2e/fixtures/preview-host-ref/).
- **Mode B — Production deploy.** Compile + render runs locally
  (Node), output lands in R2 as a versioned, atomically-flippable
  *snapshot*. Host owns its own worker that instantiates
  `R2Snapshots({ bucket, prefix? })` and mounts
  `createSnapshotHandler({ snapshots })`. The `prefix` parameter
  supports multi-env (dev/staging/prod buckets) + multi-site
  (`sites/<id>/`) partitioning. Reference fixture:
  [`tests/e2e/fixtures/deploy-host-ref/`](tests/e2e/fixtures/deploy-host-ref/).

Founding spec: [`docs/cloudflare-validation-plan.md`](docs/cloudflare-validation-plan.md).
Dual-mode plan: [`docs/dual-mode-validation-plan.md`](docs/dual-mode-validation-plan.md).
Per-phase retros: [`docs/phases/`](docs/phases/) (one file per phase, dated).
Next-phase backlog: [`docs/next-phases.md`](docs/next-phases.md).

## Test layers

Run everything: `pnpm test`. Run one project: `pnpm vitest run --project <name>`.

| Layer | Where | Pool | Purpose |
| --- | --- | --- | --- |
| A — Node | `packages/*/src/*.test.ts` | node | Pure framework logic. Fast (~ms). |
| B — workerd | `tests/workerd/` + per-package `host-cloudflare` | workerd via `@cloudflare/vitest-pool-workers` | Code that depends on the workerd runtime. |
| D — e2e | `tests/e2e/` | node | **Real Cloudflare.** Provisions both modes per run via the `af` CLI library, deploys fixtures, asserts live behaviour. Skips when `CLOUDFLARE_*` env vars are absent. |
| Conformance | `tests/conformance/astro-syntax/` | node | Real-world Astro source patterns the framework must accept. Each `.astro` fixture parses without errors. Runs at parser level today; emit-side render-equivalence is the next layer (see test-suite preamble). |

The Phase-15-era Layer C (Miniflare integration project) was retired
with Phase 26b's hard-cut — those tests exercised the deleted DOs.
Equivalent end-to-end coverage runs in Layer D against the reference
fixtures.

E2e details: globalSetup provisions a Mode B stack (deploy-host-ref
bundle), runs `deployStaticBundle` for fixtures under
`tests/e2e/fixtures/<name>/src/pages/`, then best-effort provisions
the Mode A reference host (preview-host-ref) and uploads
`files/index.astro` via its `/_aflare/site/file` endpoint. State
lands at `tests/e2e/.state/<sha7>/runtime.json` for spec workers to
read. Teardown destroys both. Stale state from a credential-less
run is wiped automatically.

### Running the e2e suite locally

The e2e project self-skips when `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` aren't reachable. To make it actually run:

1. **Build the host bundles first.** The provisioner needs both
   `tests/e2e/fixtures/deploy-host-ref/dist/worker.bundle.js` and
   `tests/e2e/fixtures/preview-host-ref/dist/worker.bundle.js` to
   exist; `pnpm test` does *not* trigger the build automatically.
   Run `node tests/e2e/fixtures/deploy-host-ref/build.mjs` and
   `node tests/e2e/fixtures/preview-host-ref/build.mjs` once after
   each pull / dep change.

2. **Provide the credentials.** `tests/e2e/global-setup.ts` reads
   `process.env.CLOUDFLARE_ACCOUNT_ID` and
   `process.env.CLOUDFLARE_API_TOKEN`. Three sources, in
   precedence order:

   - **Already in the environment** — wins. CI workflows set both
     via the job `env:` block; shells with explicit `export`s win
     over everything else.
   - **`.envrc` (account ID)** — exports the project's hard-coded
     non-secret account. Loaded by direnv on `cd` for interactive
     shells, and replicated by globalSetup for non-direnv callers.
   - **`.dev.vars` (API token)** — git-crypt-encrypted on disk;
     plaintext after `./scripts/setup` runs `git-crypt unlock`.
     Loaded by direnv via `dotenv_if_exists`, and replicated by
     globalSetup the same way. The replicated loader skips the
     file silently if it's still encrypted (NUL-byte sniff).

   Net effect: any environment that has `git-crypt unlock`-ed
   `.dev.vars` available will pick the creds up automatically,
   even without direnv. CI just sets the secret directly via the
   workflow `env:` block; `.dev.vars` isn't checked out there.

3. **Skip the no-creds short-circuit.** With both vars present
   `pnpm vitest run --project e2e` provisions a stack, deploys the
   fixtures, runs the specs, and tears down. Re-running back-to-
   back is fine — provisioning is idempotent on the per-sha worker
   name; teardown wipes `runtime.json` so a subsequent no-creds
   run self-skips cleanly.

Stack-isolation note: the suite intentionally provisions *two*
stacks per run — `aflare-stack-e2e-<sha7>` (globalSetup, owns
`basics` + `minimal`) and `aflare-stack-e2e-ceremony-<sha7>`
(deploy-ceremony.spec.ts owns it via `beforeAll`/`afterAll`).
The split exists so ceremony's redeploys don't flip the shared
`current` pointer underneath the basics/minimal specs while
Vitest runs spec files in parallel. Both stacks tear down on
suite exit; orphans get swept by the next run.

Orphan-resource note: `createR2Bucket` is idempotent — a 409 with
the `you own it` suffix (Cloudflare error code 10004) is swallowed
and the existing bucket is adopted. Teardown drops local state
unconditionally (so a partial-failed `deleteR2Bucket` doesn't leave
the worker holding a stale state file), and the next provision
re-adopts the bucket via the idempotent path. Same shape as
`deleteWorker` treating 404 as success.

## Cloudflare CLI (`af`)

The `@astroflare/cli` package exposes `af`. The same library
(`@astroflare/cli-lib`) backs the e2e test suite, so manual ops
and automated tests share a single registry under
`tests/e2e/.state/<sha7>/`.

Run from source (no build step): `pnpm exec tsx packages/cli/src/cli.ts <verb>`.

Reference host bundles (built per-fixture, not framework-shipped):
- Mode B: `node tests/e2e/fixtures/deploy-host-ref/build.mjs` →
  `dist/worker.bundle.js`. `provisionStack` deploys this.
- Mode A: `node tests/e2e/fixtures/preview-host-ref/build.mjs` →
  `dist/worker.bundle.js`. `provisionPreviewHost` deploys this.

| Verb | Purpose |
| --- | --- |
| `provision-stack <n>` / `destroy-stack <n>` | Mode B stack: deploy-host-ref worker + R2 + DEPLOY_TOKEN. |
| `deploy-static <fixture-dir> --stack <n>` | Compile + render fixture locally, ship HTML to R2 via the snapshot layout, flip current. |
| `init / deploy / status / rollback` | Project lifecycle (Mode B end-user surface). |
| `list / inspect / health` | See all managed hosts (fixtures + stacks). |
| `gc / destroy / destroy-all` | Account-wide cleanup. |
| `doctor` | Environment sanity check (creds, state) — JSON report. |
| `snapshot list / current / cat / diff` | Read-back of Mode B snapshots — list hashes, active hash, raw bytes per route, structural diff between two snapshots. `--prefix <p>` for multi-site. |
| `exec <METHOD> <path> [--body @file]` | Ad-hoc Cloudflare REST passthrough. |
| `logs <worker> [--tail] [--since <d>]` | Wrangler tail wrapper. |

Mode A has no public `af` verbs (host-driven). The cli-lib internally
exposes `provisionPreviewHost` / `destroyPreviewHost` /
`loadPreviewHostBundle` — used by the e2e harness, not the user
surface. Hosts integrate via `@astroflare/host-cloudflare`
(`createCoordinator`, `createPreviewHandler`, `acceptHmrSocket`,
`SqlCache`, `createWorkerdExecutor`, `WorkspaceSite`).

Credentials: `.dev.vars` holds `CLOUDFLARE_API_TOKEN` (git-crypt locally;
GitHub repo secret in CI). `CLOUDFLARE_ACCOUNT_ID` is exported by
`.envrc` (not secret). Source both before running `af` or e2e tests:
`set -a && . .dev.vars && set +a`.

## Branches

Default branch: `main`. Recent phase work was committed on a
long-running topic branch (see [memory](file:///Users/ryan/.claude/projects/-Users-ryan-dev-stablemodels-astroflare/memory/MEMORY.md)).
**Ask the user before creating new branches** — the policy here is
not "topic branch per phase."

## Memory

Each session has access to a persistent memory store at
`/Users/ryan/.claude/projects/-Users-ryan-dev-stablemodels-astroflare/memory/`.
Index in `MEMORY.md`. Use it for facts the code won't tell you
(account IDs, why a decision was made, plan-tier constraints,
user preferences). Don't duplicate things that live in code,
docs, or git history.
