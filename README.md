# astroflare

Cloudflare-native, Astro-compatible content framework.

Astroflare runs an Astro-shaped project (`src/pages/`, `.astro`/`.md`/`.mdx`,
`astroflare.config.*`) end-to-end on Cloudflare's isolate primitives:

- **Live preview** with sub-100 ms file-change-to-pixel feedback. No bundling
  in dev — transform-on-demand inside Worker Loader / Dynamic Workers, with a
  content-addressed warm cache. HMR over Hibernatable WebSockets.
- **Production build** that produces a content-addressed artifact stored in a
  Workspace, with all routes pre-rendered and SSR routes shipped as a
  Worker module map.
- **Production runtime** that serves static HTML, hashed assets, and SSR
  routes — no Node, no Vite, no sharp, no native code anywhere.

## Status

Phase 3 complete (preview server: request → file-based route → compile via
Executor.runCached → render → HTML, with the `Astro.*` API surface
populated for Tier 0). 223 tests across 5 test pools.

See [`docs/phases/`](./docs/phases/) for phase-by-phase progress and retrospectives.

## Layout

```
packages/
  astroflare-core/             # framework types + host interfaces
  astroflare-compiler/         # .astro / mdx / jsx / sfc compilers
  astroflare-runtime/          # server render() + browser hydration
  astroflare-preview/          # dev-loop heart: module graph, HMR, transform-on-demand
  astroflare-build/            # deploy: planner, bundle, render fan-out, artifact
  astroflare-test-utils/       # in-memory host impls + fixtures (substrate of all framework tests)
  astroflare-host-cloudflare/  # ONLY package allowed to import @cloudflare/* and cloudflare:
tests/
  integration/                 # end-to-end Miniflare tests
```

## The framework / host boundary (load-bearing)

Framework packages — `core`, `compiler`, `runtime`, `preview`, `build` — must
not import any Cloudflare-specific symbol. Cloudflare integration lives only
in `@astroflare/host-cloudflare`. The framework receives capabilities through
five interfaces in `@astroflare/core` (`Storage`, `Executor`, `Coordinator`,
`Transport`, `Clock`/`Logger`).

This boundary is what lets the entire framework be tested in plain Node with
in-memory implementations from `@astroflare/test-utils`.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm lint
```

## License

MIT.
