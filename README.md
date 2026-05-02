# astroflare

Cloudflare-native, Astro-compatible content framework. Runs end-to-end on
Cloudflare's isolate-based primitives (Worker Loader, `@cloudflare/shell`,
Hibernatable WS in Durable Objects, Cap'n Web RPC, Workflows). No Node, no Vite,
no sharp, no native code in either the build or the runtime path.

## Status

Phase 0 (workspace, tooling, CI) and Phase 1 (host capability interfaces +
in-memory test substrate) are complete. The build, deploy, and live-preview
pipelines are not yet wired — see `docs/phases.md` for the multi-phase plan.

```
pnpm install
pnpm run typecheck
pnpm run test
pnpm run lint
```

## Repository layout

```
packages/
  astroflare-core/             Public types + the five host-capability interfaces.
  astroflare-compiler/         (Phase 2) .astro / mdx / jsx / sfc compilers.
  astroflare-runtime/          (Phase 3) server render + hydration runtime.
  astroflare-preview/          (Phase 4) module graph, transform-on-demand, HMR.
  astroflare-build/            (Phase 7) deploy planner, bundler, SSG fan-out.
  astroflare-host-cloudflare/  Cloudflare-only host: Storage / Executor /
                               Coordinator / Transport over @cloudflare/* APIs.
  astroflare-test-utils/       In-memory MemoryStorage, MapCoordinator,
                               InProcessExecutor + fixtures + property tests.
```

## Architectural laws (load-bearing)

1. **Two regimes.** Live preview transforms on demand, never bundles. Deploys
   bundle once into a content-addressed artifact. They share only the Compile
   layer.
2. **Framework / host boundary.** `@astroflare/core` and its sibling framework
   packages must not import any Cloudflare-specific symbol. The boundary is
   enforced as a test in `packages/astroflare-test-utils/test/boundary.test.ts`.
3. **Content addressing everywhere.** Every cacheable artifact is keyed by
   SHA-256 of its inputs (truncated to 16 hex chars).
4. **The agent is part of the control plane.** File writes flow through
   `FsService.write` RPC, which atomically writes to storage and notifies the
   Coordinator. There is no out-of-band file watching.

See the design brief in the project tracker for the full rationale.
