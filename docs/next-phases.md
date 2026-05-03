# Next phases

Plan for the work after Phase 2.5b. Synthesizes carryovers from every prior
retrospective and the brief's tier targets into a phased order that respects
dependencies and brief priorities (Tier 0 ⊂ Tier 1 ⊂ Tier 2 ⊂ Tier 3,
MVP = Tier 0 + Tier 1).

## Where we are

**Done:** Phases 0–12 plus 2.5b. Framework runs end-to-end. Live preview
with HMR (additions + removals), multi-file `.astro` composition,
markdown + content collections, server endpoints + middleware
(both `.js` and `.ts`), TypeScript-authoring throughout, scoped +
global CSS, `import.meta.env` substitution, static deploy with
atomic flip including dynamic routes via `getStaticPaths`, full
Tier 0 `Astro.*` surface (`cookies`, `locals`, `slots`, `redirect`
propagation), real Worker Loader-backed Executor and Hibernatable WS
Transport in `@astroflare/host-cloudflare`, `minimal-blog` fixture.

**465 tests / 40 files / 5 pools all green.** Framework boundary holds.

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
- Shiki syntax highlighting (rehype-shiki plugin)
- User remark/rehype plugin chains via `astroflare.config.ts#markdown`
- Named exports from `.md` (`import { frontmatter } from "./post.md"`)
- Content-layer custom loaders

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
- Per-framework integrations — each is its own phase:
  - React / Preact (esbuild-wasm JSX)
  - Vue (`@vue/compiler-sfc`)
  - Svelte (`svelte/compiler`)
  - Solid (Babel-on-WASM)
  - Lit (no compile)
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

### Phase 13 — Asset pipeline + image transforms

`ImageService` host capability (interface in core, implementation in
host-cloudflare delegating to Cloudflare Images binding for transforms).
`<Image>` / `<Picture>` runtime components that emit `<img>` / `<picture>`
with the right hashed URLs. Compiler-side `import img from "./photo.png"`
returns `{ src, width, height, format }` (no actual image processing in
the compiler — metadata only).

Source maps emitted by the .astro compiler land alongside (data is on
every AST `Range`; wiring is mechanical).

**Defer:** Image format conversion (AVIF/WebP), DPR variants, blurred
placeholders.

### Phase 14 — MDX + Shiki + plugin chain

Full MDX via `@mdx-js/mdx`. Plugin chain wiring (`AstroflareConfig.markdown
.{remarkPlugins, rehypePlugins}` → unified pipeline). Shiki integration
as the canonical syntax highlighter. Named exports from `.md` (so
`import { frontmatter } from "./post.md"` works — the inline bundler
needs cross-module named-export hoisting, which is the bigger lift in
this phase).

**Defer:** MDX components-from-config, content-layer custom loaders.

### Phase 15 — Host implementation (production deploys)

`@astroflare/host-cloudflare/src/storage.ts` over `@cloudflare/workspace`
+ `@cloudflare/shell`. `coordinator-do.ts` (DO that holds the module
graph + pubsub fan-out). `project-worker.ts` entrypoint that exports
all DO classes and exposes Cap'n Web RPC services (`FsService`,
`LogService`). The Bundle DW pattern for the deploy pipeline (Workflow-
orchestrated, esbuild-wasm-driven SSR bundles).

Layer C integration tests in `tests/integration/` against this real host
under Miniflare. Acceptance criterion §11.3 — `minimal-blog` deploy
under 30 s on Miniflare.

**Defer:** `ImageService` (Phase 13's interface gets implemented here),
`EnvService` (Phase 12's env vars). They slot in but don't drive Phase 15's
shape.

### Phase 16 — Hydration runtime + first integration (React/Preact)

`<astro-island>` custom element implementing `client:load|idle|visible|media`.
Per-island serialization protocol (props serialized as JSON in a `<script
type="application/json">`, hydration script reads + boots the framework).
React/Preact integration first because it's the smallest compile path
(esbuild-wasm JSX) and the largest market.

Per-island client bundling at deploy time (each island gets its own
content-hashed JS file under `/site/<deployHash>/_islands/`). Deploy
server serves them with appropriate cache-control.

**Defer:** Other framework integrations (Phase 17–20), `client:only`
(no SSR fallback).

### Phase 17–20 — Additional framework integrations

One per phase: Vue (`@vue/compiler-sfc`), Svelte (`svelte/compiler`),
Solid (Babel-on-WASM), Lit (no compile). Each phase ≈ a day of compiler
+ runtime adapter + smoke test under Phase 16's hydration runtime.

### Phase 21 — Polish: view transitions, prefetch, RSS, sitemap

Shorter phase combining the small Tier 2 tail. View transitions (Astro's
`<ViewTransitions />` + browser API registration). Prefetch (link-hover
+ intersection-observer hooks). RSS via content collections. Sitemap
likewise. Each is small in isolation; they cluster naturally because
they all sit on top of routing + content collections.

### Phase 22 — i18n routing

`[lang]/...` route segments, locale-aware route rewriting, `Astro.currentLocale`,
`getRelativeLocaleUrl`. Belongs late because it touches routing (which
is otherwise stable) and the deploy planner (variant explosion).

### Phase 23 — Quality gates

Differential parity tests vs Astro (port their compiler test fixtures,
assert byte-equivalent HTML where the spec requires). Coverage thresholds
in CI. Modal HMR error overlay. File-deletion → `prune` wiring. Compiler
internal carve-outs (`is:raw`, regex-literal disambiguation, named/
namespace `.astro` imports). Source maps if not already in by Phase 13.

This phase is mostly grindy quality work that's been deferred across
prior phases. Worth its own focused pass to draw a clean line.

## Cross-cutting work (rides along)

These improvements are small enough to ride along with whichever phase
naturally touches them:

- **Modal HMR overlay** — fits inside Phase 16 (when we touch the HMR
  client for hydration anyway)
- ~~**`graphRemove → prune`** — fits inside Phase 10~~ ✓ Phase 10
- **Source maps** — fits inside Phase 13 (asset pipeline touches the
  compiler's emit path)
- **`is:raw` proper handling** — fits inside Phase 14 (MDX touches the
  compiler)
- ~~**Regex literal disambiguation** — fits inside Phase 11~~ ✓ Phase 11
- **Coverage thresholds** — fits inside Phase 23 (quality pass)
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
- **End of Phase 16:** first interactive site (React/Preact island in
  an otherwise-static page) works end-to-end.
- **End of Phase 23:** every acceptance criterion (§11.1–6) measurable
  in CI with explicit gates.

## Order rationale (one paragraph)

Phase 10 (Tier 0 carryovers) closes a real gap — the brief lists
`getStaticPaths` in Tier 0 but we never shipped it, and `Astro.cookies`
/ `Astro.locals` are the surface middleware was designed to set up.
Phase 11 (TS) is the highest-impact unlock for real-world adoption —
most Astro projects are TS-first. Phase 12 (CSS) and Phase 13 (assets)
make the framework usable for blogs / docs sites without major
workarounds. Phase 14 (MDX + plugins) is content-site polish. Phase 15
(host) is the moment we can deploy to production. Phase 16+ (Tier 2)
adds interactivity. Phase 23 closes the quality loop. The dependency
chain forces Phase 15 before any "ship to Cloudflare" claim and
Phase 16 before any "real interactive site" claim — everything else
is sequencing on user value.
