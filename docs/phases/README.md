# Phase tracking

Per §12.5 of the brief: each phase ends with a demo, a green test suite, and a
written retrospective covering what surprised you. The retrospective is for the
next phase's planner.

- [`phase-00-bootstrap.md`](./phase-00-bootstrap.md) — workspace, tooling, CI.
- [`phase-01-interfaces-and-test-harness.md`](./phase-01-interfaces-and-test-harness.md) — five host interfaces + in-memory test harness + property tests.
- [`phase-02-astro-compiler.md`](./phase-02-astro-compiler.md) — `.astro` parser + emitter + working runtime ABI + 106 new tests.
- [`phase-02_5-workerd-test-pool.md`](./phase-02_5-workerd-test-pool.md) — runtime tests moved to workerd Layer B + architectural findings on Vite/Miniflare/Worker Loader.
- [`phase-03-preview-server.md`](./phase-03-preview-server.md) — `AstroGlobal`, `render()`, file-based router, preview server, 25 new tests covering the full request→render pipeline.
- [`phase-04-module-graph.md`](./phase-04-module-graph.md) — module graph + closure walker + inline bundler + per-module compile cache; multi-file `.astro` composition unblocked.
- [`phase-05-hmr.md`](./phase-05-hmr.md) — HMR client + script injection + preview-server HMR pipeline + reactive route discovery; the dev-loop is now reactive end-to-end (Layer A).
- [`phase-06-tier1.md`](./phase-06-tier1.md) — markdown compiler + content collections (Zod-typed) + Tier 1 starter set.
- [`phase-07-deploy.md`](./phase-07-deploy.md) — build planner + render fan-out + manifest + atomic flip + deploy server.
- [`phase-08-middleware-endpoints.md`](./phase-08-middleware-endpoints.md) — `src/middleware.js` + `.js` server endpoints with method dispatch.
- [`phase-09-hardening.md`](./phase-09-hardening.md) — `examples/minimal-blog` fixture, dev error overlay, hardening sweep.
- [`phase-02_5b-host-implementation.md`](./phase-02_5b-host-implementation.md) — Phase 2.5 deferral list closed: real `WorkerdExecutor`, Hibernatable WS Transport, workerd compiler-e2e, latency + soak.
- [`phase-10-tier0-closeout.md`](./phase-10-tier0-closeout.md) — `getStaticPaths` + `Astro.cookies` / `locals` / `slots` / redirect propagation + file-removal `prune` HMR. 427 tests.
- [`phase-11-typescript.md`](./phase-11-typescript.md) — esbuild-wasm-backed TS strip in compiler; `.ts` endpoints + `.ts` middleware; regex-literal disambiguation in expression parser. 445 tests.
- [`phase-12-css-and-env.md`](./phase-12-css-and-env.md) — scoped + global `<style>` blocks via per-component data-aflare-h hash; raw-text parsing for `<style>` / `<script>`; `import.meta.env` compile-time substitution via esbuild `define`. **465 tests.**
- (later phases land here as they complete)
