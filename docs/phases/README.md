# Phase tracking

Per §12.5 of the brief: each phase ends with a demo, a green test suite, and a
written retrospective covering what surprised you. The retrospective is for the
next phase's planner.

- [`phase-00-bootstrap.md`](./phase-00-bootstrap.md) — workspace, tooling, CI.
- [`phase-01-interfaces-and-test-harness.md`](./phase-01-interfaces-and-test-harness.md) — five host interfaces + in-memory test harness + property tests.
- [`phase-02-astro-compiler.md`](./phase-02-astro-compiler.md) — `.astro` parser + emitter + working runtime ABI + 106 new tests.
- [`phase-02_5-workerd-test-pool.md`](./phase-02_5-workerd-test-pool.md) — runtime tests moved to workerd Layer B + architectural findings on Vite/Miniflare/Worker Loader.
- [`phase-03-preview-server.md`](./phase-03-preview-server.md) — `AstroGlobal`, `render()`, file-based router, preview server, 25 new tests covering the full request→render pipeline.
- (later phases land here as they complete)
