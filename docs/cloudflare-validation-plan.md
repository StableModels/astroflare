# Cloudflare-validation plan — Phases 21–24

> **Superseded (2026-05-03).** This founding spec drove Phases
> 21–24 (Cloudflare e2e validation), but the architecture it
> describes — `host-cloudflare`'s "project worker entrypoint",
> R2 storage adapter, DO Coordinator, the `Storage` interface —
> was refactored across the framework / host boundary in Phase
> 26+. Hosts now own the worker entrypoint and the DO; Astroflare
> ships factories (`createCoordinator`, `createPreviewHandler`,
> `createSnapshotHandler`) and adapters (`WorkspaceSite`,
> `R2Snapshots`, `SqlCache`). See CLAUDE.md and
> [`phases/phase-26-host-driven-preview.md`](./phases/phase-26-host-driven-preview.md)
> for the live picture. This file is preserved as historical
> context: the test categories it lists (compiler-on-Cloudflare,
> runtime-on-Cloudflare, deploy ceremony, HMR roundtrip, hydration,
> Worker Loader executor) all shipped — they just live in the
> Layer D e2e suite under `tests/e2e/`.

Pre-release acceptance: prove that Astroflare runs as expected on
real Cloudflare, end-to-end, before we ship.

This plan picks up where Phases 0–20 (plus the deferred-children
sweep) left off. The previous work brought the framework to
"green locally" — every framework primitive has unit, integration,
and Miniflare-pool coverage. What's missing is the bridge: do the
same primitives behave the same way when running on actual
Cloudflare infrastructure? The phases below close that gap.

## Where we are

**Done (locally green):** Phases 0–20 plus the deferred-children
sweep. 750 tests in 7 pools all pass on `pnpm test`. The framework
compiles, renders, hydrates, deploys (via Miniflare), and the
`af` CLI orchestrates manual ops. `host-cloudflare` ships R2
storage, DO-backed Coordinator, Hibernatable WS Transport, Worker
Loader executor — all exercised against Miniflare.

**Done (orchestration-only, not framework):** `tests/e2e/` runs
against real Cloudflare. It validates the *plumbing* — the `af`
CLI provisions Workers via REST, enables the workers.dev
subdomain, R2 buckets get created, teardown is clean. But the
deployed workers are hand-written `worker.js` files that
pre-render HTML. They don't exercise Astroflare itself. So we
have:

- ✅ Cloudflare REST API integration (verified)
- ✅ Public URL routing (verified)
- ✅ Lifecycle: provision → fetch → destroy (verified)
- ❌ Compiler-on-Cloudflare (never run)
- ❌ Runtime renderer-on-Cloudflare (never run)
- ❌ Deploy ceremony (`/_aflare/deploy` + R2 source upload + Worker
  Loader render fan-out) (never run)
- ❌ HMR-on-Cloudflare (never run)
- ❌ Hydration / islands-on-Cloudflare (never run)
- ❌ Middleware / endpoints / content collections / MDX / i18n /
  Image / view transitions / RSS — none exercised on Cloudflare

We've never actually proved Astroflare works on the platform we
target. That's the gap.

## Framework vs runtime: the delineation

**Astroflare** is the framework — code in `packages/*`.
The thing developers author against. The compiler. The runtime.
The CLI. The host adapter. We own its correctness.

**Cloudflare** is the runtime environment — workerd, Workers, R2,
Durable Objects, KV, Cloudflare Images, Workflows. Astroflare
runs ON it. We don't own its correctness; we own the contract
between the two.

Astroflare provides **mechanisms** for getting the framework into
Cloudflare:

- The `@astroflare/host-cloudflare` package — the project worker
  entrypoint, R2 storage adapter, DO Coordinator + HMR
  durable-object classes, Worker Loader executor, Hibernatable
  WebSocket transport. These are the runtime primitives the
  framework needs Cloudflare-side.
- The `af` CLI — `init` to scaffold, `deploy` to push sources,
  `provision` / `destroy` for managed Workers, `status` /
  `inspect` / `health` for diagnostics.
- A reference stack-provisioning helper (Phase 21 below) — wires
  the bindings together so users don't have to author
  `wrangler.toml` from scratch.

**What we test:** every Astroflare mechanism intended to run on
Cloudflare actually does, end-to-end and (where useful) in
isolation. Once a stack is up, every framework feature works
against it.

**What we don't test:** how a user *gets* Astroflare onto
Cloudflare in their environment. The way each user wires `af
deploy` into their CI, their wrangler config, their custom
infrastructure varies. We test that our tools work; we don't
test someone's particular pipeline. The Phase 21 stack
provisioner is a *reference implementation* — users adopt it,
fork it, or replace it.

## What's still incomplete from earlier phases

Carried forward from Phase 15c / 16c / 19b / 20b. Status: stable,
not blocking pre-release if the new phases land.

- **Phase 15c — Cap'n Web wire-protocol RPC services.** The
  `FsService` / `LogService` / `EnvService` / `ImageService`
  interfaces ship; live `WorkerEntrypoint` classes don't.
  Workflow-orchestrated parallel render fan-out and
  cross-isolate `getSecret` are the same shape. Folded into
  Phase 23 if a fixture exposes the gap.
- **Phase 16c — shared React chunk.** Multi-island pages
  re-import from `/_aflare/react.js` — module cache dedupes the
  bytes after the first hit, but each page still does the
  resolution. Becomes a perf cleanup once Phase 22 confirms
  React fixtures work end-to-end.
- **Phase 19b — Astro corpus differential parity.** Substantial
  effort; deferred until post-release demand. Phase 22's fixtures
  give us framework-level coverage on Cloudflare, which is a
  stronger acceptance gate than byte-for-byte parity with Astro's
  output.
- **Phase 20b — observe verbs + remaining Astro fixtures.**
  `logs` / `metrics` / `trace` are nice-to-have; not blocking. The
  remaining Astro corpus fixtures (portfolio, framework-react,
  non-html-pages, middleware, with-mdx, hackernews) get folded
  into Phase 22's fixture rollout.
- **Tier 3 (out of MVP):** `astro:*` integration hook API, server
  islands, server actions, DB, sessions. Vue / Svelte / Solid /
  Lit. Stays cut.

## Phase 21 — Stack provisioning (the substrate)

**Goal:** a single, reusable mechanism for spinning up a real
Astroflare project worker on Cloudflare with all the bindings the
framework needs. Light coverage of the mechanism itself; the test
weight is in Phases 22–23 against the running stack.

### What lands

`af provision-stack <name>` — top-level CLI verb (and
underlying library function in `@astroflare/cli-lib`) that creates
the **complete production-shaped stack**:

- One R2 bucket (`<name>-store`) for project sources, deploy
  artifacts under `/site/<deployHash>/`, and the content cache
- DO migrations registering `CoordinatorDurableObject` and
  `HmrDurableObject` (the framework's two DO classes)
- The project worker (built from `@astroflare/host-cloudflare`'s
  `project-worker.ts`) deployed with the right bindings:
  - R2 binding `STORAGE` pointing at the project bucket
  - DO bindings `COORDINATOR` and `HMR_DO`
  - Worker Loader binding `LOADER` (for runtime isolate spawning)
  - `DEPLOY_TOKEN` env var (random per-stack secret)
- The workers.dev subdomain enabled
- A bound subdomain URL like `https://<name>.<account>.workers.dev`

**Output:** `{stackName, projectWorkerUrl, deployToken,
provisionedAt}`. Written to `tests/e2e/.state/<sha>/<name>.json`
the same way managed Workers are. Subsequent CLI calls find it
without round-tripping the API.

`af destroy-stack <name>` — symmetric teardown; deletes Worker, R2
bucket, and DO state.

### Library API

In `@astroflare/cli-lib`:

```ts
provisionStack({
  rootDir, sha7, name, client,
  projectWorkerBundle: string  // built from host-cloudflare/project-worker
}): Promise<StackState>;

destroyStack({ rootDir, sha7, name, client }): Promise<TeardownResult>;
```

`projectWorkerBundle` is built once at framework-build time (a
new `pnpm build:project-worker` step), inlined as a string into
`@astroflare/host-cloudflare`. Stack provisioners pull it from
the package — users don't author the project worker themselves.

### Test coverage (light, deliberate)

- Unit: mocked-fetch tests of `provisionStack` confirming it
  hits the right Cloudflare REST endpoints in the right order
  with the right payloads.
- One smoke test in `tests/e2e/`: provision a stack, request `/`,
  verify the project worker returns 404 (it has no deployed
  routes yet), destroy it. ~30 seconds.

What we don't try to test:
- Different stack-shaping flavours (custom bindings, additional
  KV namespaces, multi-environment setups). Users wire those
  themselves.
- CI-pipeline integrations (Terraform, GitHub Actions matrices,
  custom CD systems). Users plug `af provision-stack` into
  whatever they want.

### Acceptance

`pnpm exec af provision-stack test-stack && curl -fsI https://test-stack.<sub>.workers.dev/missing` returns 404.
`pnpm exec af destroy-stack test-stack` leaves a clean account.

## Phase 22 — Framework-on-Cloudflare end-to-end

**Goal:** every Astroflare mechanism that's supposed to run on
Cloudflare actually does. One real Astroflare fixture project
per mechanism category, deployed to a Phase-21-provisioned stack
via the real `af deploy`, exercised by `tests/e2e/*.spec.ts`
that asserts the deployed output matches what local preview
would produce.

This is the **marquee correctness gate.** Once Phase 22 is green,
we believe Astroflare runs on Cloudflare.

### Setup

`tests/e2e/global-setup.ts` (existing) extends to:

1. Provision one shared stack via Phase 21 (`af provision-stack
   aflare-test-<sha>`).
2. For each fixture under `tests/e2e/fixtures/<name>/`:
   - Stage source files (the actual `.astro` / `.md` / `.ts` /
     `.css` / etc. — *not* a hand-written `worker.js`).
   - `af deploy --url <stack-url> tests/e2e/fixtures/<name>/`
     uploads sources to the stack's R2 bucket, triggers
     `/_aflare/deploy`, project worker compiles + renders +
     stores artifacts.
   - Capture deployed routes for spec consumption.

`globalTeardown` destroys the stack.

Per-fixture deploys go to `/_aflare/deploy?prefix=<fixture>` so
multiple fixtures share a stack without trampling each other's
deploys. (Or each fixture provisions its own stack — trade-off
of parallelism vs Cloudflare resource count; Phase 21 should
support both.)

### Fixtures

Each fixture is a tiny *real* Astroflare project. Source layout:

```
tests/e2e/fixtures/<name>/
  astro.config.json       # site URL, output mode, i18n config, etc.
  src/
    pages/...             # the routes
    components/...        # any imports
    content/...           # if testing content collections
    middleware.ts         # if testing middleware
    layouts/...           # if needed
```

No `worker.js`. The project worker compiles + serves these.

**Coverage matrix** (one fixture each, ~50–200 LOC):

| Fixture | Mechanism |
|---|---|
| `basic-render` | SSR roundtrip — `<h1>{name}</h1>` produces `<h1>Edge</h1>` from the deployed Worker |
| `routing` | static routes + `[slug]` + `[...rest]` + `getStaticPaths` |
| `astro-globals` | `Astro.params` / `Astro.cookies` / `Astro.locals` / `Astro.redirect` / `Astro.slots` |
| `content` | Markdown + `getCollection` + frontmatter + named `.md` exports |
| `styling` | scoped `<style>` + `<style is:global>` + `data-aflare-h` attribution |
| `endpoints` | `.ts` server endpoints — GET / POST + content-type round-trip |
| `middleware` | `middleware.ts` setting locals; pages reading them |
| `mdx` | `.mdx` + Shiki code blocks + JSX-in-MD |
| `i18n` | `[lang]` directories + `Astro.currentLocale` + `getRelativeLocaleUrl` + `Astro.preferredLocale` |
| `islands-vanilla` | `<Counter client:load />` ships `<astro-island>`; auto-injected hydration script; `mount(el, props)` runs in the browser |
| `islands-react` | React `.tsx` island — Phase 16a adapter wraps default export, Phase 16b SSR renders to HTML, client hydrates |
| `assets` | `<Image>` / `<Picture>` + image import resolution; `/_aflare/asset/<path>` route |
| `nav-polish` | `<ViewTransitions />` + `<Prefetch />` ship the right `<script>` tags + meta markers |
| `feeds` | RSS endpoint + sitemap endpoint generated via `generateRss` / `generateSitemap` |

### Per-fixture spec shape

```ts
// tests/e2e/styling.spec.ts
const URL = process.env.AFLARE_URL_STYLING;
const describeIfE2e = URL ? describe : describe.skip;

describeIfE2e("styling fixture (Phase 22)", () => {
  it("scoped <style> attaches data-aflare-h to elements + selectors", async () => {
    const html = await (await fetch(URL)).text();
    const hashMatch = html.match(/data-aflare-h="([a-f0-9]{8})"/);
    expect(hashMatch).not.toBeNull();
    const hash = hashMatch![1];
    // The <style> selector must reference the same hash as the elements.
    expect(html).toContain(`[data-aflare-h="${hash}"] h1`);
  });
  // ... etc.
});
```

Where applicable, **assert against local-preview parity** to catch
behavioural drift between Miniflare and real Cloudflare:

```ts
it("matches local preview output byte-for-byte", async () => {
  const local = await renderViaLocalPreview(fixture, route);
  const remote = await fetch(URL + route).then((r) => r.text());
  expect(stripBoilerplate(remote)).toBe(stripBoilerplate(local));
});
```

`renderViaLocalPreview` is a helper that boots the existing
preview server in-process, renders the same fixture, and returns
HTML — same compiler / runtime as production, but local.

### Test pool budget

Each fixture's deploy takes ~3–5 seconds; assertions take ~1
second. 14 fixtures = ~70 seconds plus the one-time stack
provision (~10 seconds). Comfortable inside the existing 25-min
CI timeout.

### Acceptance

All 14 fixtures green against a real Cloudflare account; live
output matches local preview where parity is asserted; no
fixture relies on hand-written Worker bundles (no `worker.js`
files under `tests/e2e/fixtures/`).

## Phase 23 — Per-mechanism integration tests

**Goal:** when end-to-end is too coarse — a regression in HMR
versus deploy versus rendering is hard to localise from a
fixture spec — add focused tests for individual primitives
running on real Cloudflare. These are the "how do I know which
layer broke" tests.

Targets:

### Deploy ceremony (the part that *belongs* on Cloudflare)

The most Cloudflare-bound part of the framework. A failure here
is a runtime environment fingerprint, not a compiler bug.

- **Atomic flip.** Trigger `/_aflare/deploy`, watch
  `/site/current` flip; concurrent reads during the flip never
  see a half-deployed state.
- **Old hashes survive flip.** `GET /site/<oldHash>/...` works
  after a new deploy; `af rollback <oldHash>` restores.
- **Hash determinism.** Same source → same deploy hash across
  runs (content-addressing works).
- **Deploy auth.** `POST /_aflare/deploy` without bearer rejects
  401; with stale token rejects 403.
- **R2 upload skip.** Re-deploying with one file changed doesn't
  re-upload the unchanged ones (content hashes match, server
  returns "skip").
- **Render fan-out.** Deploying a 50-page fixture renders all
  pages; partial failures don't corrupt `/site/current`.

### HMR

- **WebSocket upgrade.** `/_aflare/hmr` returns 101.
- **Broadcast roundtrip.** Write a file via the project worker's
  internal API → connected WS receives `update` message. Latency
  budget assertion (§11.3 — p95 < 100ms even on real Cloudflare).
- **Hibernation.** Connection survives a 6-minute idle (the
  Hibernatable WS contract). Workers normally evict idle
  connections; the Transport's hibernation hooks must persist.
- **Multi-tab broadcast.** Two WS connections to the same
  workspace both receive an update from a third actor.

### Coordinator persistence

- **Module graph survives Worker restart.** Write an edge,
  trigger Worker restart (deploy a no-op update), graph is
  intact.
- **Reverse-edge bookkeeping.** Adding edge `a → b` then
  reading `b`'s upstream lists `a`.
- **`graphRemove` → `prune`.** Removing a path triggers a
  `prune` HMR message to subscribers.

### Storage

- **Round-trip.** Write source bytes; read them back.
- **Content-addressed cache.** Cache a hash; subsequent calls
  with the same hash hit (no re-write).
- **Concurrent writes.** Two concurrent `write(path, ...)` calls
  serialise (last-write-wins; no torn reads).

### Worker Loader executor

- **Cold spawn.** First TaskBundle fetches; latency budget
  (§11.2 — cold p95 < 300ms) holds against real Cloudflare.
- **Warm cache.** Identical TaskBundle reuses the spawned
  isolate.
- **Runtime injection.** `RuntimeBundledExecutor` makes
  `@astroflare/runtime` resolve correctly inside the spawned
  isolate.
- **`nodejs_compat` flag.** AsyncLocalStorage works
  inside the spawned isolate (the env-context plumbing relies
  on it).

### Cloudflare-binding mechanisms

- **Cloudflare Images binding.** `<Image>` runtime component
  produces URLs that Cloudflare Images serves correctly
  (Phase 15c carryover — depends on whether the test account
  has Images enabled).
- **Per-request Worker secrets.** `getSecret(name)` from inside
  user code returns the value bound to the project worker.

### Test runner

These tests live under `tests/e2e-mechanisms/` (separate from
the fixture-driven `tests/e2e/`) so each is independently
runnable. Same provisioned stack; each spec installs its own
test setup against the live URL.

### Acceptance

Every mechanism listed has at least one focused test that
passes against real Cloudflare. Latency assertions hit the
brief's §11.2/3 budgets on actual hardware (not just
Miniflare estimates).

## Phase 24 — Pre-release acceptance

**Goal:** close the loop. Astroflare is releasable when all
acceptance criteria from §11 of the brief hold against real
Cloudflare, plus a release-readiness checklist clears.

### Acceptance criteria (§11 of the brief)

- **§11.1 — `minimal-blog` v2.** 20 pages, content collections,
  layout, scoped CSS, one image. Renders end-to-end on a
  Phase-21 stack. Deploy time < 30 seconds. All pages return
  200.
- **§11.2 — preview latency.** Cold preview p95 < 300 ms; warm
  preview p95 < 60 ms. Measured against real Cloudflare (not
  Miniflare). Soak: 1000 requests through warm cache.
- **§11.3 — HMR roundtrip.** p95 < 100 ms from `onFileChanged`
  to WS message arrival.
- **§11.4 — coverage thresholds.** >85% framework / >75% host.
  Currently 75% / 65% — Phase 24 ratchets up.
- **§11.5 — type-checking acceptance.** Real-world TS Astro
  projects (test against 2–3 popular templates) compile clean
  through Astroflare.
- **§11.6 — differential parity.** ≥80% byte-equivalent on
  Astro's compiler corpus (Phase 19b promotion).

### Release-readiness checklist

- **Documentation:**
  - "Get started" — `pnpm create af my-site` + `cd my-site && af
    deploy` walkthrough
  - "Provisioning your own stack" — Phase 21 reference + how to
    customise (custom bindings, multi-environment)
  - "Migration from Astro" — what the framework supports, what
    the carve-outs are
  - API reference for every `@astroflare/runtime` export
- **Backwards-compat plan:**
  - The deploy contract (`POST /_aflare/deploy` shape) is part
    of the framework's public API. Future versions must be
    backwards-compatible at this boundary.
  - Stack-version migration: how `af deploy` updates an existing
    stack to a newer framework version without losing data.
- **Version pinning:**
  - The `host-cloudflare` package's project worker carries a
    framework-version constant. `af deploy` checks it matches
    the local `@astroflare/cli` version; mismatches refuse
    cleanly.
- **Soak test (released):** a real production-ish deploy
  (deployed once at release-time, kept running) takes 24h of
  traffic without corrupting deploy state, leaking memory, or
  losing HMR connections during normal idle.
- **Secret hygiene:** the release checklist asserts no
  `CLOUDFLARE_*` variables leak into the published package's
  `dist/`; the user's secrets stay in their account.

### What "released" means

- npm publish for `@astroflare/{core,compiler,runtime,preview,
  build,content,cli,cli-lib,host-cloudflare}` (and tests-utils
  for users writing their own integrations)
- A v0.1.0 cut tagged on main
- Public docs at a stable URL
- A changelog committing to a deprecation policy for breaking
  changes

### Acceptance

Every checklist item ✓. The brief's §11 acceptance criteria
verified against the same Phase-21 stack the rest of the suite
uses. A clean release smoke run can deploy `minimal-blog` from
scratch in under one minute.

## Test-shape summary

| Layer | What it covers | Where it runs | When |
|---|---|---|---|
| Unit (Layer A) | Functions / classes / pure logic | Node | Every `pnpm test` |
| Workerd pool (Layer B) | `host-cloudflare` primitives in workerd | workerd via vitest-pool-workers | Every `pnpm test` |
| Miniflare integration (Layer C) | End-to-end with real bindings | Miniflare | Every `pnpm test` |
| **e2e fixtures (Phase 22)** | **Astroflare on real Cloudflare** | **Live Cloudflare** | **Push to main + nightly** |
| **e2e mechanisms (Phase 23)** | **Per-primitive on real Cloudflare** | **Live Cloudflare** | **Push to main + nightly** |
| Differential corpus (Phase 19b) | Astro byte-parity | Node | Quarterly check |

The first three layers are the inner loop — fast feedback. The
e2e layers are the outer loop — slower (real network), but the
acceptance gate.

## What we explicitly don't test

- **Specific user-deploy pipelines.** The `af` CLI's deploy
  ceremony is what we own; how a user calls it from their CD
  is theirs.
- **Custom Cloudflare account configurations.** Different
  accounts have different binding flavours, different domain
  setups, different feature flags. We test against one
  reference shape (the Phase-21 stack); compatibility with
  account variations is the user's responsibility, with
  documentation guidance.
- **Edge-network geography.** A `*.workers.dev` URL hits the
  nearest edge from the test runner. Multi-region behaviour is
  Cloudflare's contract, not Astroflare's.
- **Cloudflare service degradations.** When Cloudflare's
  services are down, our tests fail — that's the cost of
  testing the real thing. Detected via the nightly schedule.
- **Custom-domain provisioning** (DNS zones, SSL certs). DNS
  automation is its own domain. Workers.dev URLs are
  sufficient for tests.
- **Load testing / synthetic traffic.** Phase 24's soak test is
  correctness-shaped, not stress-shaped. Production load
  testing is the user's responsibility.

## Order rationale

Phase 21 is the prerequisite — every later phase needs a real
project worker to test against. Without it we're back to
hand-written `worker.js` files.

Phase 22 is the marquee acceptance gate. It's the closest
proxy to "does Astroflare work on Cloudflare?" — every
mechanism gets exercised.

Phase 23 supplements 22 with per-mechanism diagnostics.
Without 22, 23 is hard to motivate (just unit tests with extra
latency); without 23, a 22 failure can't be localised to a
specific primitive.

Phase 24 is the release gate. A green Phase 24 means the
framework is ready to publish. A red Phase 24 means we know
exactly what's blocking release.

## Out of scope for this plan

- Vue / Svelte / Solid / Lit — opinionated cut, kept.
- Server islands / server actions / DB / sessions — Tier 3.
- Cloudflare-side product features Astroflare doesn't surface
  (Workers AI, Vectorize, Queues, etc.) — possible future work
  if user demand emerges.
- Multi-account / team-billing operations — out of framework
  scope.
