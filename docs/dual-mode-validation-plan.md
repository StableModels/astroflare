# Dual-mode validation plan — Phases 25–26

Two distinct lifecycles exist for an Astroflare site running on
Cloudflare; both need explicit proof that they work end-to-end. The
phases below land them, with the same fixture flowing through both
to prove they produce identical output.

## The two modes

### Mode A — Preview (in-worker compile + HMR)

Source files (`.astro`, `.md`, etc.) live in a workspace storage
backed by either R2 or a Durable Object (the framework's
`Storage` interface abstracts both). A **preview worker** running
on Cloudflare reads source from the workspace on demand,
compiles it via `@astroflare/compiler#compileAstro`, runs the
output through the runtime renderer, and returns rendered HTML.
File mutations (POST to a write endpoint) trigger HMR
broadcasts on a hibernating WebSocket so connected browsers
reload automatically.

Use case: live editing, design review against a real Cloudflare
runtime, "preview deploys" tied to a branch or PR, in-Worker
content editing with immediate feedback.

### Mode B — Production deploy (R2 prerender + static serve)

The same source files compile + render *locally* (in `af deploy`
or CI), the rendered HTML uploads to R2 under
`files/site/<deployHash>/`, the deploy hash flips
`files/site/current` atomically, and a slim **stack worker**
serves the prerendered output.

Use case: production traffic — fast, low-cost, no per-request
compile, atomic rollbacks via `af rollback <hash>`.

## What's in place today

- ✅ Mode B end-to-end: Phases 21–24 prove provisioning, deploy,
  and serving on real Cloudflare. The slim stack worker is 18 KiB
  bundled.
- ✅ Storage abstraction: `R2Storage` (real R2) +
  `MemoryStorage` (tests). DO-backed storage is achievable through
  `Coordinator`'s pattern but isn't a standalone `Storage` impl
  yet.
- ✅ Compiler + runtime: parse / emit / render functions all run
  successfully in Node (test pool), workerd (Layer B), and
  Miniflare (Layer C), and now on real Cloudflare via the
  preview worker.
- ✅ HMR transport: `HibernatingHmrTransport` over a DO works in
  workerd; the preview worker exposes `/_aflare/hmr` for upgrade.
- ✅ Phase 25: preview-worker bundle (171 KiB) builds; CLI verbs
  `provision-preview` / `upload-files` / `destroy-preview` wired
  in; e2e harness provisions a preview stack alongside the static
  stack, uploads a fixture's source tree, and exercises the
  in-Worker compile + render path.
- ❌ HMR roundtrip on real Cloudflare: WS upgrade endpoint exists
  but no live test of the file-write → broadcast → receive cycle
  yet (Phase 25b).
- ❌ Same-fixture parity between Mode A and Mode B: never asserted.

## Phase 25 — In-worker compile + workspace + HMR

**Goal:** prove Mode A works on real Cloudflare. A preview worker
compiles `.astro` files from R2 on demand, renders, returns HTML.
A WebSocket endpoint broadcasts HMR updates when sources change.

### What lands

**`@astroflare/host-cloudflare/preview-worker.ts`** — new entrypoint.

Bindings (mirrors `stack-worker` plus Worker Loader):
- `FILES` — R2 bucket holding workspace sources
- `COORDINATOR_DO` — module-graph + reverse edges
- `HMR_DO` — hibernating WebSocket transport
- `LOADER` — Worker Loader for spawning compile + render isolates
- `DEPLOY_TOKEN` — bearer for write/admin endpoints

Routes:
- `GET /<path>` — looks up the matching `.astro` file in the R2
  workspace, compiles + renders + returns HTML.
- `POST /_aflare/file?path=<workspace-path>` — body is the new file
  bytes; writes to R2, calls `coordinator.notifyFileChanged`,
  broadcasts HMR `update`.
- `DELETE /_aflare/file?path=<workspace-path>` — removes from R2,
  calls `coordinator.graphRemove`, broadcasts HMR `prune`.
- `GET /_aflare/hmr` — WebSocket upgrade to the HMR transport.
- `GET /_aflare/preview/info` — diagnostic JSON (worker identity,
  workspace size, HMR connection count).

The fetch handler routes to `createPreviewServer` from
`@astroflare/preview` for the rendering path, supplying a Host
backed by `R2Storage` + `DurableObjectCoordinator` +
`HibernatingHmrTransport` + `WorkerdExecutor`. The executor uses
the Worker Loader binding to spawn isolates for the compile +
render step. The runtime is inlined as strings (same pattern
`RuntimeBundledExecutor` uses) so spawned isolates resolve
runtime imports correctly.

Bundle size budget: target ≤ 5 MiB compressed (under Cloudflare's
10 MiB paid-plan ceiling). Strategy:
- `external: ["cloudflare:workers", "react", "react-dom/server",
  "@mdx-js/mdx", "shiki", ...]` — everything dynamically-imported
  is excluded.
- `compileAstro` called with `skipTsTransform: true` so esbuild-wasm
  isn't loaded. Trade-off: TypeScript frontmatter unsupported in
  preview mode (Phase 25c lifts this when TS strip moves into a
  separate Worker Loader-spawned isolate).
- MDX deferred (`.mdx` files in workspace return 415 in preview).

### CLI surface

- `af provision-preview <name>` — provisions a preview stack:
  Worker (preview-worker bundle) + R2 + DOs + Worker Loader binding +
  DEPLOY_TOKEN.
- `af upload-files <fixture-dir> --preview <name>` — uploads each
  source file under `<fixture-dir>/src/` to the preview stack's
  R2 bucket as `files/<workspace-path>`. Supports incremental
  upload (skip files whose hash already matches).
- `af destroy-preview <name>` — symmetric teardown (reuses
  `destroyStack` infrastructure).

### Tests

**Unit (cli-lib):**
- `provisionPreview` mocked-fetch test: bindings include
  `LOADER`, R2 + DO migrations match `provisionStack`'s shape.
- `uploadWorkspaceFiles` mocked-fetch test: walks `src/`, hashes
  each file, PUTs to R2 with the right keys.

**Live e2e (one preview stack per run):**
- `tests/e2e/preview.spec.ts`:
  - **In-worker compile + render** — upload an `index.astro` with
    a known frontmatter expression, fetch `/`, assert the rendered
    HTML matches what the local renderer produces (parity check).
  - **File mutation triggers re-render** — upload v1, fetch,
    upload v2, fetch again, assert the new content is served.
  - **HMR WebSocket roundtrip** — connect to `/_aflare/hmr`, write
    a file, assert an `update` message arrives within a budget.
  - **HMR hibernation** — open WS, sleep 5 minutes, write a file,
    assert message still arrives. (Cloudflare's idle eviction is
    more aggressive than workerd's; this catches divergence.)
    Optional / nightly-only — adds 5 min to the run.
  - **Multi-route compile** — upload `pages/index.astro` +
    `pages/about.astro`, hit each, assert both render correctly.
  - **404** — request a path that has no matching source, assert
    404.

### Acceptance signals for Phase 25

- `af provision-preview <name> && af upload-files <fixture> --preview <name>`
  produces a working URL where the fixture renders live.
- The same fixture's HTML output matches what `deployStaticBundle`
  produces locally (for static frontmatter).
- HMR WS upgrade succeeds, file POST broadcasts an `update`
  message that connected sockets receive.

## Phase 26 — Dual-mode parity proof

**Goal:** prove the same fixture produces byte-equivalent (or
trivially-different) HTML through both modes. A regression in
either mode that diverges from the other surfaces here.

### What lands

**`tests/e2e/dual-mode.spec.ts`** — single-fixture, dual-mode
assertion. Steps:

1. Provision both a preview stack and a deploy stack (or
   one stack with both worker types — see below).
2. Upload the `basics` fixture's sources to the preview stack.
3. Run `deployStaticBundle` against the deploy stack.
4. Fetch `/basics/` from each.
5. Assert structural parity:
   - Same set of HTML elements
   - Same `data-aflare-h` scope hash
   - Same content for each tag (text content)
   - Allowed differences: response headers, server-side timing
     metadata in HTML comments
6. Repeat for `/basics/about`.

The byte-for-byte comparison may have tiny diffs (e.g., the
preview path serves the page via `<astro-island>` for islands
on every load, the deploy path can pre-bake them). For static
fixtures with no islands those should match; the test asserts
that and documents the carve-outs.

**Documentation update:** `docs/cloudflare-validation-plan.md`
gains a section explaining the two-mode model — what each is
for, what guarantees each provides, when to use which.

### Acceptance signals for Phase 26

- Live test passes on real Cloudflare in CI's e2e workflow.
- A regression in either path (preview-worker compile bug, deploy
  ceremony bug) surfaces as a parity-test failure.

## Phase 25b (carve-out) — TS in workspace, MDX in workspace

Once Phase 25 is green, the next iteration:

- Move TS-strip + MDX compile into a separate Worker Loader-spawned
  isolate ("compiler isolate") so the parent preview-worker stays
  slim. Compiled output streams back to the parent for the render
  step.
- Workspace-stored TS/TSX/MDX files compile correctly in preview.
- React island SSR via `react-dom/server` deferred until a
  user-demand signal — keep the parent worker slim.

## Phase 25c (carve-out) — DO-backed workspace

The framework's `Storage` interface accepts any backend. R2 is the
default for cost (infinite, cheap). For sub-millisecond reads in
high-traffic preview scenarios, a DO-backed `Storage` puts the
workspace in DO sqlite. Phase 25c lands `DurableObjectStorage`
alongside `R2Storage`; the preview worker becomes binding-agnostic.

## Order rationale

Phase 25 is the meat — the in-worker compile path has never been
tested on real Cloudflare. Without it, Mode A is unverified.

Phase 26 is the parity proof. It catches drift between the two
modes that would otherwise be invisible until users complained.

Both build on the Phase 21 stack-provisioning substrate. The slim
stack-worker stays in place for production deploys; preview-worker
is a sibling.
