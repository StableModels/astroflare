# Phase 25 — Preview worker (Mode A) on real Cloudflare

**Goal:** prove the in-Worker compile + render lifecycle works on
real Cloudflare. Plan was in
[`../dual-mode-validation-plan.md`](../dual-mode-validation-plan.md).

**Status:** done. Both lifecycles green on real Cloudflare:

- Mode B (deploy): 11 e2e assertions across 5 spec files (Phases 21–24).
- Mode A (preview): 6 e2e assertions in `tests/e2e/preview.spec.ts`.
- **17/17 e2e green.** **752 unit + integration tests green.**

## What landed

### Framework

- **`packages/astroflare-host-cloudflare/src/preview-worker.ts`** —
  new entrypoint. Reads `.astro` source from R2, compiles with
  `skipTsTransform: true` (no esbuild-wasm in the parent bundle),
  spawns a Worker Loader isolate carrying the runtime modules + a
  render shim, returns rendered HTML. Also exposes:
  - `POST /_aflare/file?path=<workspace-path>` — bearer-auth'd
    file write that calls `Coordinator.onFileChanged` to
    publish HMR.
  - `GET /_aflare/hmr` — WS upgrade to `HibernatingHmrTransport`.
  - `GET /_aflare/preview/info` — diagnostic JSON.
- **`packages/astroflare-compiler/src/astro/index.ts`** — converted
  the static `import { transformTS }` to a dynamic import inside
  the `if (!opts.skipTsTransform)` branch. Lets `esbuild-wasm`
  stay external in the preview-worker bundle.
- **`packages/astroflare-host-cloudflare/package.json`** — adds
  `@astroflare/compiler` as a runtime dep + new `./preview-worker`
  subpath export.

### Build

- **`scripts/build-preview-worker.mjs`** — esbuild bundle with
  `__AFLARE_RUNTIME_MODULES__` substituted from
  `packages/astroflare-runtime/dist/*.js`. `esbuild-wasm` marked
  external (the dead `transformTS` branch never executes in the
  preview-worker; if it did, workerd would fail to resolve it).
  Output: **171 KiB**, hard cap at 800 KiB.

### CLI

Three new verbs in `af`, all backed by exports from
`@astroflare/cli-lib`:

- `provision-preview <name>` → `provisionPreview` — stack with
  R2 bucket + Coordinator/HMR DOs + `worker_loader` binding +
  `DEPLOY_TOKEN` secret.
- `destroy-preview <name>` → `destroyPreview` — symmetric teardown
  (empties R2 first, then drops bucket + worker).
- `upload-files <fixture-dir> --preview <name>` → `uploadFiles` —
  walks `src/` + `public/`, POSTs each file to `/_aflare/file`
  with the persisted `DEPLOY_TOKEN`. Retries DNS-not-yet-propagated
  404s with backoff.

State for preview stacks goes in
`tests/e2e/.state/<sha7>/<name>.preview.json` (distinct from
`<name>.stack.json` for Mode B stacks); shape in
`packages/astroflare-cli-lib/src/state.ts#PreviewState`.

The `WorkerBinding` REST type now includes
`{ type: "worker_loader"; name: string }`.

### Tests

- **`tests/e2e/preview.spec.ts`** — 6 live assertions:
  - `/_aflare/preview/info` returns the worker's identity.
  - `/` renders the uploaded `index.astro` with frontmatter
    interpolation intact (proof of in-Worker compile + render).
  - 404 for unknown routes (uses `Storage.stat` first to avoid
    500 from the contract'd "throws on miss" `read`).
  - `/_aflare/file` rejects unauthenticated writes (401).
  - `/_aflare/file` accepts authenticated writes and returns the
    content hash.
  - Source rewrite + re-fetch surfaces the new content (poor-man's
    HMR — proves R2 reads aren't stale-cached across writes).
- **`tests/e2e/global-setup.ts`** — provisions the preview stack
  alongside the deploy stack, waits for workers.dev DNS to settle,
  then uploads the `minimal` fixture's source. Failure surfaces as
  an error (no graceful skip — paid plan is the floor).
- **`tests/e2e/runtime-env.ts`** — adds required `previewUrl`,
  `previewDeployToken`, `previewFixtures` fields, plus
  `clearRuntimeEnv()` so credential-less reruns don't read
  torn-down URLs.

## Carve-outs (what Phase 25 explicitly didn't ship)

- **Phase 25b — TS / MDX in workspace.** Today the preview worker
  passes `skipTsTransform: true`; TypeScript syntax in `.astro`
  frontmatter doesn't strip server-side. Plan (recorded in
  dual-mode-validation-plan.md): hoist TS strip + MDX compile
  into a separate Worker Loader isolate ("compiler isolate")
  reachable from the preview-worker via RPC.
- **Phase 25c — DO-backed Storage.** R2 is the workspace today.
  `DurableObjectStorage` would give sub-ms reads for high-traffic
  preview scenarios; the framework's `Storage` interface already
  fits.
- **Live HMR roundtrip on real Cloudflare.** The WS upgrade
  endpoint exists and the spec rewrite test proves the data path
  is correct. A real `client connect → file write → broadcast
  received` assertion against Cloudflare is still missing
  (Phase 25 retro should pick this up too).
- **Multi-fixture preview routing.** `upload-files` writes one
  fixture's tree at a time — the worker resolves URLs against
  `/src/pages/...` with no prefix. Mode B already does prefixed
  routing (`/<fixture>/...`); preview will follow the same shape.

## What's next: Phase 26 — dual-mode parity

**Goal:** assert the same fixture produces equivalent HTML through
both modes. A regression in either path that diverges from the
other surfaces here.

Sketch (full plan in
[`../dual-mode-validation-plan.md`](../dual-mode-validation-plan.md#phase-26--dual-mode-parity-proof)):

- One spec, `tests/e2e/dual-mode.spec.ts`. Provision both stacks
  (already done by globalSetup).
- Upload `basics` fixture sources to the preview stack.
- Run `deployStaticBundle` against the deploy stack with the same
  fixture (already done by globalSetup).
- Fetch the same routes from both and assert structural parity:
  same elements, same `data-aflare-h` scope hashes, same text per
  tag. Document allowed differences (timing comments, hydration
  markers if any).

## Operational findings worth knowing

- **Worker Loader is paid-plan only.** The `worker_loader` binding
  returns `code: 10195` on free-plan accounts. The dev account is
  on a paid plan as of 2026-05-03 and Mode A provisions cleanly.
  See memory `project_worker_loader_paid_plan.md`.
- **workers.dev DNS lag.** Newly-provisioned workers serve a
  Cloudflare 404 page until DNS propagates (3–10 s typical). The
  e2e setup waits 8s by default (`AFLARE_SETTLE_MS`); the
  upload-files retry loop catches stragglers.
- **`Storage.read` throws on miss** per the interface contract;
  callers that want "not found → 404" must `stat` first. Both
  `preview-worker.ts` and the deploy serve path now do this.
- **Bundle size budget for Mode A.** 171 KiB with the runtime
  inlined; the next ~600 KiB headroom is for compiler additions.
  Don't statically import anything that pulls
  `@astroflare/preview` (it transitively pulls `transformTS` →
  `esbuild-wasm` → bundle blowup).
