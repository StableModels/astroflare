# deploy-host-ref — reference Mode B deploy host

A minimal reference host for the Phase 26b host-driven build/serve
architecture. Astroflare ships zero canonical worker entrypoints; this
fixture is the host application that brings the worker, instantiates
`R2Snapshots`, and mounts the framework's `createSnapshotHandler`.

## Files

- `wrangler.jsonc` — single R2 binding, no DOs.
- `src/worker.ts` — ~15-line root worker that instantiates
  `R2Snapshots` (with optional `SITE_PREFIX` env var for multi-env /
  multi-site partitioning) and forwards every request to the framework
  handler.

## Multi-environment / multi-site usage

The `prefix` parameter on `R2Snapshots` / `R2SnapshotSink` lets a
single bucket hold deploys for many sites:

```
SITE_BUCKET = vibe-prod
SITE_PREFIX = sites/<site-id>/

→ R2 keys land at:
  sites/<site-id>/<snapshotHash>/<route-key>
  sites/<site-id>/current
```

A multi-site host extracts the site identity from the request (subdomain,
JWT, header, etc.), constructs an `R2Snapshots` per request, and calls
`createSnapshotHandler({ snapshots })`. Per-request instantiation is
cheap — `R2Snapshots` is a thin wrapper.

## Status (Phase 26b)

The new shape ships:

- `Snapshots` / `SnapshotEntry` / `SnapshotSink` interfaces
  (`@astroflare/core`)
- `R2Snapshots` / `R2SnapshotSink` adapters
  (`@astroflare/host-cloudflare`)
- `createSnapshotHandler` (`@astroflare/build`)

Still pending (separate commit on this branch):

1. Reshape `cli-lib`'s `deployStaticBundle` to write through
   `R2SnapshotSink` (REST-backed) instead of the legacy
   `files/site/<hash>/...` layout.
2. Provision this fixture as the Mode B host worker (replace
   `loadStackWorkerBundle` + the existing `stack-worker.bundle.js`).
3. Hard-cut the deprecated shape: delete `stack-worker.ts`,
   `project-worker.ts`, `R2Storage`, `coordinator-do.ts`,
   `transport.ts`, `deploy-server.ts`, `artifact.ts`, `planner.ts`,
   `render-fanout.ts`, the `deploy()` legacy export, and the
   integration tests that exercise them.

Until those land, Mode B continues to use the legacy shape. The new
shape is unit-tested at Layer A; e2e validation lands when the harness
is rewired.
