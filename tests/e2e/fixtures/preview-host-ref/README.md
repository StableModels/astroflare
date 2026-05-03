# preview-host-ref — reference Mode A host

A minimal vibe-coding-style host application demonstrating the
Phase 26 host-driven preview integration. Astroflare ships zero
DOs and zero entrypoints; this fixture is the host application that
brings the SiteDurableObject + Workspace + worker, instantiates
Astroflare's coordinator + handler factories, and exposes preview
rendering with HMR.

## Files

- `wrangler.jsonc` — DO migration, R2 binding, Worker Loader binding.
- `src/site-do.ts` — `SiteDurableObject` extending `DurableObject`.
  Constructor wires `@cloudflare/shell` Workspace + Astroflare's
  coordinator + change pipeline + WS lifecycle delegates.
- `src/worker.ts` — root worker that resolves SiteDO IDs and forwards
  `stub.fetch(req)`.
- `files/index.astro` — minimal page the test seeds into the
  workspace.

## Status (Phase 26)

The integration shape is documented as code; live e2e validation
against real Cloudflare requires:

1. Bundling `@astroflare/runtime`'s compiled output as a string map
   the worker can pass to `createWorkerdExecutor({ runtime })` —
   formerly `scripts/build-preview-worker.mjs` substituted
   `__AFLARE_RUNTIME_MODULES__`. A host-side build helper
   replaces it.
2. A globalSetup pathway that uploads source files into the
   SiteDO via direct DO RPC (not `POST /_aflare/file`).

Both follow-ups are bounded; `tests/e2e/preview.spec.ts` returns
once they land. Until then, Mode A e2e coverage is deferred to the
local Layer C integration test (Miniflare).
