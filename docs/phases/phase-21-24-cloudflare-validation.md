# Phases 21–24 — Cloudflare validation retro

**Goal:** prove Astroflare runs on real Cloudflare, end-to-end,
before we release. The plan was in
[`cloudflare-validation-plan.md`](../cloudflare-validation-plan.md).

**Status:** Phases 21 + 22 + 23 done; Phase 24 partially done
(latency assertions added; full §11 acceptance + the release
checklist remain). 761 local tests / 67 files / 7 pools all green;
9 live e2e assertions against real Cloudflare green.

## Where the framework now stands on Cloudflare

The Cloudflare runtime substrate works. A user can:

- Run `af provision-stack <name>` — gets a Worker + R2 bucket +
  DO bindings + DEPLOY_TOKEN, all in one call.
- Compile + render an Astroflare project locally (using framework
  code) and upload static artifacts to the stack's R2 bucket.
- Serve those artifacts from the live edge via the stack worker.
- Atomic deploy flips: redeploys swap `/site/current` to a new
  hash; old hashes stay accessible at their direct paths.

Every primitive listed above is exercised by an e2e test against
real Cloudflare. A regression in any one of them surfaces in CI's
nightly e2e workflow.

## Per-phase outcomes

### Phase 21 — Stack provisioning ✓

- `provisionStack` / `destroyStack` library functions in cli-lib.
- `af provision-stack <name>` and `af destroy-stack <name>` CLI verbs.
- Slim `stack-worker.ts` (18 KiB bundled) — request handling +
  R2 read + DO class registration. No compiler in the parent
  worker (it'd blow Cloudflare's size budget).
- Build: `scripts/build-stack-worker.mjs` (esbuild bundle).
- Migrations use `new_sqlite_classes` (works on free + paid plans).
- Live smoke: 3 stack-worker assertions (info endpoint, deploy/status,
  404 routing).

### Phase 22 — Framework-on-Cloudflare end-to-end ✓

- `deployStaticBundle` library function. Walks a fixture's
  `src/pages/`, compiles each route via the framework's
  `compileAstro`, renders via `render()`, uploads HTML to R2 under
  `files/site/<hash>/<route>.html`, atomically flips
  `files/site/current`.
- Real `.astro` fixtures replace hand-written `worker.js` files.
  `minimal` and `basics` fixtures cover SSR roundtrip,
  multi-page routing, and scoped CSS attribution.
- `tests/e2e/runtime-env.ts` — file-backed handoff between
  globalSetup and spec workers (vitest's worker pool snapshots
  process.env at fork time; post-setup mutations don't propagate).
- `emptyR2Bucket` API method + `destroyStack` empties before
  bucket delete.
- 3 live framework-correctness assertions (greeting interpolation,
  scoped CSS hash matching, multi-route deploy).

### Phase 23 — Per-mechanism integration tests ✓

- `tests/e2e/deploy-ceremony.spec.ts` — drives multiple deploys
  in-test to assert hash determinism, atomic flip, and
  currentDeploy reflection in `/_aflare/stack/info`.
- 3 new live assertions exercising the deploy mechanism distinct
  from the rendered output (a redeploy bug looks like a render
  bug from outside; this localises).

### Phase 24 — Pre-release acceptance (partial)

Done:
- `tests/e2e/latency.spec.ts` — measures warm /minimal/ p95 +
  404-path p95 against real Cloudflare. Bounds at 500ms (generous
  while we collect data); will tighten once SSR-on-Cloudflare lands
  the brief's actual budgets.
- This retro.

Not done — folded into Phase 24b:
- §11.1 minimal-blog v2 (20 pages, content collections, layout,
  scoped CSS, image): the framework supports the mechanisms but
  there's no built fixture matching that shape.
- §11.5 type-checking on real Astro projects: no test harness
  pulls external Astro projects.
- §11.6 Astro corpus differential: still substantial, deferred.
- Release-readiness checklist: docs, backwards-compat plan, soak,
  version pinning, secret hygiene scrub. The framework's not yet
  release-shaped (no published packages, no install path, no
  documentation site).

## What's still incomplete (active follow-ups)

These items are necessary before a v0.1.0 release; they were
explicitly de-scoped from Phases 21–24 because each is its own
substantial body of work.

### Phase 22b — Live SSR on Cloudflare

The slim stack worker doesn't include the compiler. SSR routes
(`output: "server"`) can't run in-Worker today. Two viable paths:

1. **Compile locally, ship pre-rendered HTML.** The current
   approach. SSR routes that read request data won't work.
2. **Move compile + render into Worker Loader-spawned isolates.**
   The original Phase-15 design intended this; spawning the
   compiler-as-isolate per request keeps the parent worker slim.
   Needs experimentation to confirm Worker Loader's bundle limits
   accommodate the compiler.

Until 22b lands, the e2e suite covers static-output sites only.
The brief's minimal-blog v2 is static, so 22b isn't blocking.

### Phase 22c — In-Worker deploy ceremony

Today's `deployStaticBundle` runs in the test process. A real
production deploy would have the user upload sources to R2, then
trigger `/_aflare/deploy` on the stack worker, which compiles +
renders in-Worker. Same compiler-in-Worker question as 22b.

For Phase 22c we ship `af deploy` running locally (Node-side
toolchain), which is a legitimate user-facing flow. Phase 22b/c
is the "deploy ceremony runs on the edge" alternative, useful for
CD pipelines that don't want to ship the full toolchain.

### Phase 23b — More mechanism tests

When the stack worker grows admin endpoints (HMR upgrade,
DO state inspection, executor smoke), the per-mechanism spec
suite gets:

- HMR WS upgrade + broadcast roundtrip + hibernation
- Coordinator DO persistence across Worker restarts
- R2 storage round-trip via stack endpoints
- Worker Loader cold/warm caching
- Per-request secret access from within compiled bundles
- Cloudflare Images binding through `<Image>` runtime

### Phase 24b — Release readiness

Items the v0.1.0 cut needs:

- npm publish for every `@astroflare/*` package
- "Get started" doc + walkthrough
- "Provisioning your own stack" guide (Phase 21 reference)
- "Migration from Astro" carve-out doc
- API reference (auto-generated from TS types)
- Backwards-compat declaration: the deploy contract
  (`/site/current` layout, `provisionStack`'s binding shape) is
  versioned and stable.
- Version constant in `@astroflare/cli-lib` matching
  `@astroflare/cli`; deploy time refuses on mismatch.
- Soak test: 24h continuous fetch against a stable deploy verifying
  no leakage / corruption.
- Secret hygiene scrub: no `CLOUDFLARE_*` in published `dist/`.

## Test boundary, codified

| Layer | Substrate | What it owns |
|---|---|---|
| Unit tests | Plain Node | Pure functions, AST emit, runtime-internal |
| workerd pool (Layer B) | vitest-pool-workers | Host primitives in workerd |
| Miniflare integration (Layer C) | Miniflare | End-to-end with bindings |
| **e2e fixtures** | **Real Cloudflare** | **Framework on the edge** |
| **e2e mechanisms** | **Real Cloudflare** | **Per-primitive on the edge** |
| **e2e latency** | **Real Cloudflare** | **Production timings** |

The first three layers are fast feedback (every `pnpm test`). The
e2e layers run on push-to-main + nightly via `e2e.yml`.

## What we explicitly don't test (still)

- Specific user-deploy pipelines (Terraform / GitHub Actions / etc.)
- Custom Cloudflare account configurations (different binding shapes)
- Multi-region geographic routing
- Cloudflare service degradations
- Custom-domain provisioning
- Load testing / synthetic traffic

## Acceptance signals

- `pnpm typecheck` — green.
- `pnpm test` — **761 tests across 67 files / 7 pools, all green**;
  9 live e2e tests skip when CLOUDFLARE_API_TOKEN is absent (PR
  CI skips them; e2e workflow runs them on push-to-main + nightly).
- Live e2e: provision → deploy → assert → teardown round-trip is
  clean; no Cloudflare resources leak after a successful run.
- Framework boundary check — every test that runs framework code
  on Cloudflare uses the same compile + render functions the unit
  tests use; no Cloudflare-specific framework code paths.
