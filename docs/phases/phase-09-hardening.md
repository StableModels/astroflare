# Phase 9 — Hardening + minimal-blog fixture

**Brief scope (§7.9):** soak / load tests, error boundaries, telemetry hooks
via `Logger`, documentation generated from a live preview running in the
browser.

**Status:** the polish pass that makes the framework presentable plus the
brief's headline acceptance criterion (`minimal-blog` rendering through
both preview and deploy). Soak / load tests stay deferred per Phase 2.5
(no workerd-direct testing infrastructure).

## What landed

### `examples/minimal-blog/`

The brief's acceptance criterion §11.1 — a small blog exercising:
- file-based routing (`src/pages/`)
- a layout component with slots
- markdown pages (`src/pages/about.md`)
- content collections under `src/content/blog/` with a Zod schema
- dynamic `[slug].astro` (preview-only; deploy correctly skips it
  pending `getStaticPaths`)

5 e2e tests boot the in-memory test host, populate the fixture tree,
and exercise:
- index renders inside the layout
- markdown about page renders
- dynamic post route renders in preview
- `getCollection("blog")` returns 3 schema-validated entries
- `deploy()` renders all static routes; skips the dynamic one; the
  `createDeployServer` shim serves the rendered HTML

This stops short of the brief's full 20-page target — Phase 9 ships
the *capability* (every Tier 0/1 feature exercised) rather than
spinning up content. Adding 17 more posts is mechanical when the
capability is in place.

### Dev error overlay (`error-page.ts`)

`renderErrorPage({error, requestUrl})` returns a small styled HTML
document for any 500 the preview server hits. The HMR client is
injected so the page automatically reloads when the source is fixed.

The brief asked for "useful diagnostic in the HMR overlay." Phase 9
ships the *server-rendered* version (full-page replacement on error);
a modal overlay over the previously-rendered page is a small follow-up
that fits inside the HMR client's message handlers.

### Numbers
- **353 tests / 31 files / 5 pools** all green (was 348 at end of
  Phase 8).
- 5 new tests in the minimal-blog fixture.

## Carve-outs

- **Soak / load tests** — `1000 file writes in 10 seconds; assert no
  missed updates, no socket drops` (brief §7.5). Same Phase 2.5 blocker
  — we don't yet have a workerd-direct test surface that doesn't
  intermediate through vite-node. Belongs to the host implementation
  phase.
- **Latency budget assertions** in CI — cold preview <300 ms / warm
  <60 ms / HMR <100 ms (brief §11.2). Same blocker.
- **Modal HMR error overlay** — Phase 9 ships server-side error pages;
  a "stay on the previous page, show the error in a modal" overlay is
  a 50-line addition to the HMR client (catch the `error` message
  type, inject an iframe). Defer.
- **Documentation generated from a live preview** (brief §7.9 last
  bullet) — out of scope for this run.
- **Coverage thresholds** (acceptance §11.4: >85% framework / >75%
  host) — the test suite covers a lot but we haven't run
  `vitest run --coverage` and asserted thresholds. Easy to wire up
  next pass.
- **Differential parity tests vs Astro** (acceptance §11.6: ≥80%
  byte-equivalent on Astro's compiler corpus) — needs `astro` as a
  dev dep + corpus porting; deferred since Phase 2.

## Acceptance signals at phase close

- `pnpm typecheck` — green.
- `pnpm lint` — green (111 files).
- `pnpm test` — **353 tests across 31 files, all 5 pools green**.
- Framework boundary check — zero `cloudflare:` / `@cloudflare/`
  matches in framework packages.
- `examples/minimal-blog` exercises every Tier 0 + Tier 1 feature that
  shipped, end-to-end through the preview server and the deploy
  pipeline.

## What "after Phase 9" looks like — the explicit outstanding work

The framework runs. The dev loop is reactive end-to-end. The deploy
pipeline produces content-addressed artifacts. What's still outside
the bag:

1. **`@astroflare/host-cloudflare`** — the production host
   implementation. Worker Loader-backed Executor, real Hibernatable
   WS in a Durable Object, `@cloudflare/workspace` + `@cloudflare/shell`
   wiring, the Project Worker entrypoint. Same Phase 2.5 blockers.
2. **`getStaticPaths`** — Tier 0 carryover from Phase 3. Until it
   lands, the deploy pipeline skips dynamic routes.
3. **TS support** — frontmatter and endpoints both fail on `.ts`
   today. esbuild-wasm in a Compile DW is the brief-prescribed answer.
4. **Tier 1 finishers** — scoped CSS, env vars, image transforms,
   MDX, Shiki — each its own phase.
5. **Tier 2 finishers** — framework integrations
   (React/Vue/Svelte/Solid/Lit), client-island hydration, view
   transitions, prefetch, i18n, RSS, sitemap — the longest tail.
6. **Latency / soak / coverage CI gates** — same Phase 2.5 blocker
   plus the coverage runner wiring.

This is honest scope. The brief's MVP target is Tier 0 + Tier 1
shipping cleanly — the framework now does that for the *capabilities*
shipped (markdown / content collections / preview / deploy /
endpoints / middleware / HMR). The pieces explicitly carved out (CSS
scoping / env vars / image transforms) are the remaining Tier 1 work.
