# Next phases

> **2026-05-03 update.** Phases 0–25 are done. Both Cloudflare
> lifecycles (Mode A preview, Mode B deploy) are green on real
> Cloudflare. **Active plan for Phases 25b/c + 26 lives in
> [`dual-mode-validation-plan.md`](./dual-mode-validation-plan.md);
> read that first.** The sections below are the historical Tier-1
> backlog from the Phase 13 era — useful as a long-term carve-out
> reference but not the immediate roadmap.

Plan for the work after Phase 2.5b. Synthesizes carryovers from every prior
retrospective and the brief's tier targets into a phased order that respects
dependencies and brief priorities (Tier 0 ⊂ Tier 1 ⊂ Tier 2 ⊂ Tier 3,
MVP = Tier 0 + Tier 1).

## Where we are

**Done:** Phases 0–13 plus 2.5b. Framework runs end-to-end. Live preview
with HMR (additions + removals), multi-file `.astro` composition,
markdown + content collections, server endpoints + middleware
(both `.js` and `.ts`), TypeScript-authoring throughout, scoped +
global CSS, `import.meta.env` substitution, asset pipeline +
`<Image>` / `<Picture>` runtime components, static deploy with
atomic flip including dynamic routes via `getStaticPaths`, full
Tier 0 `Astro.*` surface (`cookies`, `locals`, `slots`, `redirect`
propagation), real Worker Loader-backed Executor and Hibernatable WS
Transport in `@astroflare/host-cloudflare`, `minimal-blog` fixture.

**482 tests / 43 files / 5 pools all green.** Framework boundary holds.

## Outstanding work, categorized

### A — Tier 0 carryovers (must land for MVP)
- ~~`getStaticPaths()`~~ ✓ Phase 10
- ~~`Astro.cookies` / `Astro.locals`~~ ✓ Phase 10
- ~~`Astro.redirect` propagation~~ ✓ Phase 10
- ~~`Astro.slots` imperative API~~ ✓ Phase 10
- `Astro.self` (recursive components — niche, deferred)

### B — Tier 1 finishers
- ~~TS support throughout (frontmatter + endpoints)~~ ✓ Phase 11
- ~~Scoped CSS (`<style>` block + selector hash + element attribution)~~ ✓ Phase 12
- ~~Global CSS~~ ✓ Phase 12 / CSS modules deferred
- ~~`import.meta.env` substitution~~ ✓ Phase 12 / `astro:env` runtime → Phase 15
- Image asset pipeline (`<Image>` / `<Picture>` + `ImageService` host capability + Cloudflare Images)
- MDX (full JSX-in-markdown via `@mdx-js/mdx`)
- Shiki syntax highlighting (shipped as the one default; not user-pluggable for now)
- Named exports from `.md` (`import { frontmatter } from "./post.md"`)
- Content-layer custom loaders (deferred)
- User remark/rehype plugin chains (deferred — surfacing only if real demand appears)

### C — Host implementation (production deploys)
- `@astroflare/host-cloudflare/src/storage.ts` — `@cloudflare/workspace`-backed Storage
- `@astroflare/host-cloudflare/src/coordinator-do.ts` — DO-backed Coordinator (per-workspace state, persistent module graph)
- `@astroflare/host-cloudflare/src/project-worker.ts` — entrypoint Worker that wires Storage/Coordinator/Transport/Executor into a single `fetch` handler
- `FsService` / `LogService` / `ImageService` / `EnvService` Cap'n Web RPC classes (§9.3)
- Bundle DW + esbuild-wasm (deploy-time bundling for SSR routes and per-island chunks)
- Workflow-orchestrated parallel render fan-out

### D — Tier 2 (interactive sites)
- Hydration runtime + `<astro-island>` custom element (`client:load|idle|visible|media|only`)
- Per-island client bundling at deploy time
- React integration only (esbuild-wasm JSX). **Vue / Svelte / Solid /
  Lit are explicitly out of scope** — opinionated bet that React (and
  by extension Preact, sharing the JSX surface) covers the audience
  for the foreseeable. Re-evaluate after a real userbase surfaces.
- View transitions
- Prefetch
- i18n routing
- RSS
- Sitemap

### E — Quality / hardening (cross-cutting)
- Differential parity tests vs Astro (acceptance §11.6 — ≥80% byte-equivalent on Astro's compiler corpus)
- Coverage thresholds in CI (acceptance §11.4 — >85% framework / >75% host)
- Modal HMR error overlay (Phase 9 follow-up)
- Source maps from compiler (data already on every AST node's `Range`)
- `is:raw` directive proper emit handling
- Regex-literal disambiguation in expression bracket-matcher
- File-deletion → `Coordinator.graphRemove` → `prune` HMR message
- Documentation pass (live preview docs in browser)

### F — Tier 3 (defer, brief explicitly carves)
- Full `astro:*` integration hook API for third-party integrations
- Server islands (out-of-band SSR for slow paths)
- Server actions (Astro 4.x feature)
- DB integrations
- Sessions

### G — End-to-end validation (Phase 20 capstone)
- Fixtures copied from `withastro/astro/examples` (license-attributed)
- `aflare-e2e` CLI: provision / orchestrate / introspect / observe / teardown
- Vitest runner driving each fixture through real Cloudflare
- CI workflow with the Cloudflare API token from secrets
- Acceptance §11.* validated on the edge, not just inside Miniflare

## Proposed next phases

Ordered by dependency + brief priority (close Tier 0/1 first, then host, then
Tier 2). Each phase ≈ one focused work session, with explicit carve-outs.

### Phase 10 — Tier 0 close-out: getStaticPaths + Astro.* finishers ✓

**Done.** Retro: [`docs/phases/phase-10-tier0-closeout.md`](./phases/phase-10-tier0-closeout.md).
46 new tests; 424 total. `getStaticPaths`, `Astro.cookies`,
`Astro.locals`, `Astro.slots`, `Astro.redirect` propagation, plus the
cross-cutting `graphRemove` → `prune` HMR wiring.

**Defer:** `Astro.self` (recursive components — niche).

### Phase 11 — TS support ✓

**Done.** Retro: [`docs/phases/phase-11-typescript.md`](./phases/phase-11-typescript.md).
18 new tests; 445 total. esbuild-wasm-backed TS strip in
`@astroflare/compiler/ts`; `.astro` frontmatter, `.ts` endpoints,
and `.ts` middleware all flow through it. Cross-cutting
regex-literal disambiguation in the parser landed alongside.

**Defer:** TS-aware error reporting (line numbers from TS source survive
via source maps — Phase 13).

### Phase 12 — CSS (scoped + global) + env vars ✓

**Done.** Retro: [`docs/phases/phase-12-css-and-env.md`](./phases/phase-12-css-and-env.md).
20 new tests; 465 total. Per-component scoped CSS via `data-aflare-h`,
`<style is:global>` pass-through, raw-text parsing for `<style>` and
`<script>`, `import.meta.env.<KEY>` compile-time substitution via
esbuild `define`.

**Defer:** CSS modules (`*.module.css`), PostCSS, `astro:env` runtime
helpers (`getSecret(name)` etc.) — moves to Phase 15 (host
`EnvService`).

### Phase 13 — Asset pipeline + image transforms ✓

**Done.** Retro: [`docs/phases/phase-13-asset-pipeline.md`](./phases/phase-13-asset-pipeline.md).
17 new tests; 482 total. `ImageService` interface +
`MemoryImageService` stub; compile-time image import substitution;
runtime `<Image>` / `<Picture>` components; preview-server
`/_aflare/asset/<path>` route; v3 source-map placeholder.

**Defer:** Image format conversion (AVIF/WebP), DPR variants, blurred
placeholders, per-token source maps.

### Phase 14 — MDX + Shiki + named `.md` exports ✓

**Done.** Retro: [`docs/phases/phase-14-mdx-shiki.md`](./phases/phase-14-mdx-shiki.md).
39 new tests; 521 total. Full MDX via `@mdx-js/mdx`; Shiki as the
one opinionated default syntax-highlighter (`github-dark`, narrow
language allowlist, `{shiki: false}` opt-out). Inline bundler now
hoists arbitrary named exports cross-module so
`import { frontmatter } from "./post.md"` works end-to-end —
`parseImportClause` + `COMPILABLE_IMPORT_RE` handle every shape
(default / named / namespace / mixed). JSX runtime in
`@astroflare/runtime/jsx-runtime`; module-graph routes `.mdx`;
content reader picks up `.mdx` entries.

**Defer:** User remark/rehype plugin chains (no demand yet). MDX
components-from-config (`MDXProvider`-style). Custom Shiki
transformers (line numbers / diff highlighting / copy buttons).
Content-layer custom loaders.

### Phase 15 — Host implementation (production deploys) ✓

**Done.** Retro: [`docs/phases/phase-15-host-implementation.md`](./phases/phase-15-host-implementation.md).
29 new tests; 550 total. R2-backed `Storage`, DO-backed
`Coordinator` with persistent module graph (sqlite-backed via
`ctx.storage`), `project-worker.ts` entrypoint that wires every
primitive into a single fetch handler. `RuntimeBundledExecutor`
solves the runtime-injection problem by augmenting every spawned
isolate's module map with the framework runtime as inlined source.
Layer C integration tests in `tests/integration/` cover routing,
cache invalidation, cross-module named imports, asset serving,
DO persistence, and reverse-edge bookkeeping — all against real
R2 + DOs + Worker Loader under Miniflare.

### Phase 15a — Deploy pipeline ✓

**Done.** Retro: [`docs/phases/phase-15a-deploy-pipeline.md`](./phases/phase-15a-deploy-pipeline.md).
24 new tests; 574 total. Hybrid project-worker (deploy artifact
serving first, live SSR fallback); `POST /_aflare/deploy` endpoint
runs the render ceremony server-side with bearer auth;
`@astroflare/cli` ships `aflare deploy` / `status` / `rollback`
commands using only Node stdlib (R2 uploads via Cloudflare REST
API + content-hash skip). `getSecret` runtime helper for parent-
worker scope; `WorkerdExecutor` now sets `nodejs_compat` on
spawned isolates; `DurableObjectCoordinator` retries on stub
invalidation via stub-factory pattern.

**Phase 15b (still deferred):** Workflow-orchestrated parallel
render fan-out; Cap'n Web RPC services (`FsService` /
`LogService` / `ImageService` / `EnvService`); `ImageService`
production wiring against the Cloudflare Images binding; cross-
isolate `getSecret` (threading env through the task context);
`aflare init` scaffolding and `aflare deploy --watch`. None of
these block the next-phase plan; they ride along when demand
surfaces.

### Phase 16 — Hydration runtime + island plumbing ✓

**Done.** Retro: [`docs/phases/phase-16-hydration.md`](./phases/phase-16-hydration.md).
25 new tests; 599 total. Compiler emits real `$island(...)` for
`client:*` directives (was Phase 2's placeholder comment). Server
helper produces `<astro-island>` markup with directive attributes,
props as JSON, and SSR'd content (for `.astro`/`.md`/`.mdx` imports
where SSR works) or empty (for `.tsx`/`.jsx` where SSR awaits
React DOM Server). Hydration client (`hydration-client.ts`) defines
`<astro-island>` custom element with all four trigger types
(`load` / `idle` / `visible` / `media`); `HYDRATION_CLIENT_SOURCE`
exported as a string for the preview server to ship verbatim.
Preview server: `/_aflare/hydration.js` route + `/_aflare/island?path=...`
route that compiles `.ts`/`.tsx`/`.jsx` via esbuild-wasm and passes
`.js`/`.mjs` through. Hydration script auto-injected on pages that
contain at least one `<astro-island>`.

**Phase 16a ✓ Done.** (Deferred sweep — see
[phase-deferred-sweep.md](./phases/phase-deferred-sweep.md).)
`wrapReactIslandSource(src)` injects mount glue around a default-
exported `.tsx` / `.jsx` component; `MOUNT_REACT_ISLAND_SOURCE`
serves at `/_aflare/react.js` and re-exports React + ReactDOM
from esm.sh by default (overridable via the route).

**Phase 16b ✓ Done.** (Deferred sweep.) `ssrReactIsland(Component,
props)` calls `react-dom/server#renderToString` at SSR time. The
emitter routes `.tsx` / `.jsx` islands through it (gracefully falls
back to client-only when React isn't bundled). `react@18.3.1` +
`react-dom@18.3.1` runtime devDeps.

**Out of scope (deliberately):** Vue, Svelte, Solid, Lit. Opinionated
bet that React covers the user base for now.

### Phase 17 — Polish: view transitions, prefetch, RSS, sitemap ✓

**Done.** Retro: [`docs/phases/phase-17-polish.md`](./phases/phase-17-polish.md).
29 new tests; 628 total. `<ViewTransitions />` + `<Prefetch />`
runtime components; `/_aflare/view-transitions.js` +
`/_aflare/prefetch.js` preview-server routes; `generateRss()` +
`generateSitemap()` pure-function helpers exported from
`@astroflare/runtime`. Same `_CLIENT_SOURCE` string + typed-installer
pattern Phase 5 / 16 use.

**Defer:** auto-built sitemap from the route table; Atom feed
alternative; `<a data-aflare-reload>` opt-out for view transitions;
`tap` prefetch strategy; custom directive registry. Picked up if
there's demand.

### Phase 18 — i18n routing ✓

**Done.** Retro: [`docs/phases/phase-18-i18n.md`](./phases/phase-18-i18n.md).
15 new tests; 643 total. `AstroflareConfig.i18n` config schema
(locales / defaultLocale / routing strategy);
`deriveLocale(pathname, config)` + `getRelativeLocaleUrl(locale,
path, config)` runtime helpers; `Astro.currentLocale` threaded
through `SharedRenderContext`, `RenderContext`, `AstroGlobal`, and
`EndpointContext`. No router change needed — `[lang]` segments are
already generic dynamic params from Phase 3.

**Defer:** locale-aware route fallback (serve `/fr/missing` from
`/missing.astro` when localised copy is absent);
`Astro.preferredLocale` from `Accept-Language`; the rest of Astro's
i18n helper surface (`getAbsoluteLocaleUrl`, `getLocaleByPath`,
etc.); variant pre-expansion in the deploy planner.

### Phase 19 — Quality gates ✓

**Done.** Retro: [`docs/phases/phase-19-quality.md`](./phases/phase-19-quality.md).
15 new tests; 658 total. Modal hydration / HMR error overlay
(`@astroflare/runtime` + auto-injected
`/_aflare/error-overlay.js`); compiler `is:raw` directive
properly suppresses expression evaluation + child compilation;
file-deletion → `prune` HMR wiring verified across coordinator +
preview server (already plumbed since earlier phases); coverage
thresholds added to root `vitest.config.ts` for the v8 provider
(brief §11.4 — separate framework + host bars).

**Defer:** differential parity tests vs Astro fixture corpus
(Phase 20's e2e fixtures cover the closely-related "deploys-
cleanly" story); per-token source maps from the compiler;
parser-level `is:raw` (today the directive is honoured at emit
time, not at parse time — the AST is still built normally so
users still hit expression-parser errors inside raw children
when the body has unbalanced parens). Production-deploy overlay
scrub is also a follow-up.

### Phases 21–24 — Cloudflare-validation plan

The next active work. **See
[`cloudflare-validation-plan.md`](./cloudflare-validation-plan.md)
for the detailed plan.** Closes the gap exposed at the end of
Phase 20: today's e2e tests validate the orchestration loop
(`af` CLI → Cloudflare REST → live Worker URL) but the deployed
Workers are hand-written `worker.js` files, so the framework
itself has never been exercised on real Cloudflare.

The plan delineates **Astroflare** (the framework — what we own)
from **Cloudflare** (the runtime environment — what we run on).
It deliberately under-tests the mechanism for getting Astroflare
into Cloudflare (users do that differently) and over-tests every
framework mechanism that's supposed to run there once it's
running.

- **Phase 21** — Stack provisioning. `af provision-stack <name>`
  spins up the project worker with all bindings (R2, DOs, Worker
  Loader, DEPLOY_TOKEN). Light coverage of the mechanism; it's
  the substrate for the rest.
- **Phase 22** — Framework-on-Cloudflare end-to-end. ~14
  fixtures, each a real Astroflare project (no hand-written
  `worker.js`), deployed via `af deploy` to a Phase-21 stack.
  Specs assert deployed output matches local-preview parity.
- **Phase 23** — Per-mechanism integration tests. Targeted
  Cloudflare tests for deploy-ceremony atomicity, HMR
  hibernation, Coordinator persistence, R2 round-trip, Worker
  Loader cold/warm, secrets, image binding.
- **Phase 24** — Pre-release acceptance. §11.1–6 verified
  against real Cloudflare; release-readiness checklist
  (docs / backwards-compat / soak / version pinning / secret
  hygiene). Green Phase 24 → releasable.

### Phase 20 — End-to-end tests against live Cloudflare ✓

**Done (scaffolding).** Retro: [`docs/phases/phase-20-e2e.md`](./phases/phase-20-e2e.md).
22 new tests; 678 total / 60 files / 7 pools all green.
`tools/aflare-e2e/` CLI (provision / teardown / teardown-all /
list verbs) with mocked-fetch unit tests; `tests/e2e/` separate
vitest project (opt-in via `AFLARE_E2E_URL`); `minimal` fixture +
`.github/workflows/e2e.yml` running on push-to-main + nightly.
`tests/e2e/.state/` is gitignored so resource state doesn't bleed
into commits.

**Phase 20a (deferred):** the rest of the verbs (`build`/`deploy`/
`run`/`preview`/`inspect`/`status`/`logs`/`metrics`/`trace`/`gc`)
plus the rest of the Astro fixture corpus (basics / blog /
portfolio / non-html-pages / middleware / ssr / framework-react /
with-mdx / hackernews). The architectural slots are ready in
`cli.ts`'s dispatch + `tests/e2e/fixtures/`; each is mechanical
to add.

---

(The full Phase 20 plan below stays for reference.)

The capstone phase. Every prior phase is verified locally — unit
tests, Miniflare integration, workerd pool. Phase 20 closes the
loop by exercising the framework against *real* Cloudflare:
provisioning Workers, Durable Objects, KV, and R2 against the live
edge, deploying a curated set of Astro fixture sites, and asserting
that what runs in production matches what we tested locally.

**Fixtures.** Copy a curated set of examples from
[`withastro/astro/examples`](https://github.com/withastro/astro/tree/main/examples)
into `tests/e2e/fixtures/`. Each fixture preserves Astro's MIT
license attribution and gains an `e2e.spec.ts`. Initial set, picked
to span the supported feature surface: `minimal` (smallest deploy),
`basics` (routes / layouts / scoped CSS), `blog` (content
collections + RSS + sitemap), `portfolio` (`<Image>` + Cloudflare
Images), `non-html-pages` (endpoints), `middleware`, `ssr`,
`framework-react` (gates Phase 16), `with-mdx` (gates Phase 14),
and `hackernews` (a larger real-world site combining features).
Each deploys to its own Worker (`aflare-e2e-<fixture>-<sha7>`) on a
`*.workers.dev` subdomain so runs are self-contained and need no
DNS provisioning.

**CLI: `aflare-e2e` (`tools/aflare-e2e/`).** A Node CLI in
TypeScript wrapping the Cloudflare REST API + `wrangler`. Five
command groups mirror the verbs the user called out — provision,
orchestrate, introspect, observe, teardown:

```
PROVISION
  provision <fixture>     Create Worker, KV, R2, DOs for one fixture
  provision-all           Provision every fixture in tests/e2e/fixtures/

ORCHESTRATE
  build <fixture>         Local Astroflare build (writes to dist/)
  deploy <fixture>        Upload bundle, bind KV/R2/DOs
  preview <fixture>       Local wrangler dev session
  run <fixture> [pattern] Vitest e2e against the deployed instance
  run-all                 Full cycle: provision → deploy → test → teardown

INTROSPECT
  inspect <fixture>       Resources (Worker, KV, R2, DOs) with IDs + timestamps
  list                    All provisioned fixtures in this account
  status                  Health check across every provisioned fixture

OBSERVE
  logs <fixture> [--tail] Worker logs (wrangler tail)
  metrics <fixture>       Req rate, error rate, P50/P95/P99 latency
  trace <fixture> [-N]    Workers Trace events for the last N requests

TEARDOWN
  teardown <fixture>      Destroy resources for one fixture (idempotent)
  teardown-all            Destroy every aflare-e2e-* resource
  gc                      Sweep orphans left by a crashed run
```

Resource IDs persist in `tests/e2e/.state/` (gitignored) so
subsequent commands find what `provision` created without
round-tripping the API. Names are deterministic
(`aflare-e2e-<fixture>-<sha7>`) so concurrent CI runs on different
SHAs don't collide.

**Test runner: `tests/e2e/`.** A separate vitest project — the
workerd pool is in-process; this one needs real network. Each
`e2e.spec.ts` receives the deployed URL plus resource handles and
asserts: SSR pages render byte-equivalent to local preview output,
static assets serve with correct cache headers, `<Image>` URLs
return the right format, endpoints serve their declared
content-type, hydrated islands boot client-side and respond to
events, and Worker latency stays inside acceptance §11.2/3
budgets. The runner reads `CLOUDFLARE_API_TOKEN` from `.dev.vars`
(loaded by direnv via `.envrc`). Required token scopes: Workers
Scripts edit, KV edit, R2 edit, DO classes edit. The 1Password
reference in `scripts/setup` extends to include this token
alongside the git-crypt key.

**CI.** A separate `.github/workflows/e2e.yml` runs on push to
`main` and on a nightly schedule (catches upstream Cloudflare
regressions). `CLOUDFLARE_API_TOKEN` is already provisioned as a
repository secret (the existing `ci.yml` exposes it to its `test`
step too, inert until something needs it); the e2e workflow
references the same `secrets.CLOUDFLARE_API_TOKEN` and runs
`aflare-e2e run-all`. `CLOUDFLARE_ACCOUNT_ID` is non-secret and
lives in `.envrc` for local shells; CI sets it as a literal
`env:` value (direnv doesn't run there). Teardown runs in a
`finally` step so failed runs never leak resources.

**Defer:** Custom-domain provisioning (DNS automation is its own
project; `*.workers.dev` is sufficient for tests). Load testing /
synthetic traffic (Phase 20 is correctness, not stress).
Multi-region geographic assertions (a single workers.dev URL hits
the nearest edge — global routing tests are a separate concern).

## Cross-cutting work (rides along)

These improvements are small enough to ride along with whichever phase
naturally touches them:

- **Modal HMR overlay** — fits inside Phase 16 (when we touch the HMR
  client for hydration anyway)
- ~~**`graphRemove → prune`** — fits inside Phase 10~~ ✓ Phase 10
- ~~**Source maps** — fits inside Phase 13~~ ✓ Phase 13 (structural placeholder; per-token in Phase 19)
- **`is:raw` proper handling** — fits inside Phase 14 (MDX touches the
  compiler)
- ~~**Regex literal disambiguation** — fits inside Phase 11~~ ✓ Phase 11
- **Coverage thresholds** — fits inside Phase 19 (quality pass)
- **Workflow-driven parallel render fan-out** — fits inside Phase 15
  (host implementation)

## Tier 3 — explicitly defer

Per the brief's §3 / §10: full `astro:*` integration hook API, server
islands, server actions, DB, sessions. These are out of MVP scope; they
become "real" work after the Tier 0–2 plan above ships and there are
real users.

## Acceptance milestones along the way

- **End of Phase 11:** real-world TS Astro projects can be loaded and
  preview correctly. Acceptance criterion §11 still pending — host
  implementation for §11.2/3, Tier 2 for §3 Tier 2.
- **End of Phase 13:** `minimal-blog` v2 with images can render and
  deploy. The brief's §11.1 spec for `minimal-blog` (20 pages, content
  collections, layout, scoped CSS, one image) is met.
- **End of Phase 15:** real production deploys to Cloudflare possible.
  Acceptance §11.2/3 latency budgets measurable end-to-end.
- **End of Phase 16:** first interactive site (React island in an
  otherwise-static page) works end-to-end.
- **End of Phase 19:** every acceptance criterion (§11.1–6) measurable
  in CI with explicit gates (locally — Miniflare + workerd pool).
- **End of Phase 20:** every acceptance criterion validated against
  *real* Cloudflare. The `aflare-e2e` CLI provisions, deploys, tests,
  observes, and tears down each fixture against the live edge; CI runs
  it on push to `main` plus nightly. The framework can be claimed
  *production-validated*, not just *Miniflare-validated*.

## Order rationale (one paragraph)

Phase 10 (Tier 0 carryovers) closes a real gap — the brief lists
`getStaticPaths` in Tier 0 but we never shipped it, and `Astro.cookies`
/ `Astro.locals` are the surface middleware was designed to set up.
Phase 11 (TS) is the highest-impact unlock for real-world adoption —
most Astro projects are TS-first. Phase 12 (CSS) and Phase 13 (assets)
make the framework usable for blogs / docs sites without major
workarounds. Phase 14 (MDX + Shiki + named `.md` exports) is
content-site polish; user-pluggable remark/rehype chains are
deferred until real demand surfaces. Phase 15 (host) is the moment
we can deploy to production. Phase 16 adds interactivity via
React-only — Vue / Svelte / Solid / Lit are an opinionated cut.
Phases 17–18 are Tier 2 polish + i18n. Phase 19 closes the quality
loop on local tests. Phase 20 is the capstone: a custom
`aflare-e2e` CLI drives fixtures from `withastro/astro`'s public
examples through real Cloudflare infrastructure — the difference
between "passes in Miniflare" and "deploys cleanly to the edge".
The dependency chain forces Phase 15 before any "ship to
Cloudflare" claim, Phase 16 before any "real interactive site"
claim, and Phase 20 before any "production-validated" claim —
everything else is sequencing on user value.
