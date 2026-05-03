# Phase 26b — Host-driven build/serve architecture (Mode B refactor)

**Goal:** apply the architectural North Star to Mode B. Astroflare
provides build and serve primitives that take narrow capabilities;
the host owns sources, snapshot storage, path layout, and the worker
entrypoint.

**Status:** planned 2026-05-03. Sibling to Phase 26 (Mode A).
Independent migration; depends on Phase 26 only for the shared
`Site` interface.

## Why now

The Phase 26 carve-out exempted Mode B as "a build-time pipeline."
Too generous. Mode B has two halves: **build** (a function — fairly
exempt) and **serve** (a long-lived worker — fully subject to the
North Star). Today's `stack-worker.ts` is a canonical
Astroflare-owned worker entrypoint with Cloudflare bindings hardcoded
— exactly the shape the North Star prohibits.

Specific violations:
- `stack-worker.ts` is the canonical entrypoint hosts deploy.
- R2 binding name (`FILES`) and path layout (`files/site/<hash>/<route>`)
  are baked into the worker and `R2Storage`.
- `provision-stack` registers two DO classes (`CoordinatorDO`,
  `HmrDO`) that do nothing in production — vestigial from sharing
  code with the project-worker.
- `deployStaticBundle` reads from a local fixture directory; can't
  accept sources from a SiteDO `Workspace`.

Plus a real-world requirement that surfaced during design: a
vibe-coding platform runs **multiple environments** (dev / staging /
prod buckets) and **multiple sites per environment** (folder-style
paths within a bucket). Today's hardcoded `files/site/` prefix can't
support that.

## Recorded design decisions

Settled in conversation 2026-05-03:

| Decision | Choice |
|---|---|
| Naming | **Snapshot** for the versioned, atomically-flippable site output. Avoids `Artifact` (Cloudflare uses for Git FS), `Bundle` (esbuild), `Pages` (Cloudflare Pages) |
| R2 layout | Host supplies `prefix` (default `""` = bucket root). Snapshot entry: `<prefix><snapshotHash>/<route>`. Current pointer: `<prefix>current` |
| Multi-env / multi-site | Host instantiates `R2Snapshots` / `R2SnapshotSink` per `(bucket, prefix)` — typically per-request from URL/JWT/header |
| Storage adapters | Astroflare ships `R2Snapshots` / `R2SnapshotSink` as opt-in convenience helpers in `@astroflare/host-cloudflare`. Hosts that want different storage write their own |
| Build location | Same `buildSite` function runs from local Node, CI, or in-Worker via the `Executor` abstraction. Host decides where |
| Migration | Hard cut. Drop stack-worker, the DO registrations, the baked-in layout |

## Integration shape (host-side)

A host's serve worker — the minimal version, ~15 lines:

```ts
// host's deploy-worker.ts
import { createSnapshotHandler } from "@astroflare/build";
import { R2Snapshots } from "@astroflare/host-cloudflare";

interface Env {
  SITE_BUCKET: R2Bucket;
  SITE_PREFIX?: string;       // e.g. "sites/abc/"
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const snapshots = new R2Snapshots({
      bucket: env.SITE_BUCKET,
      prefix: env.SITE_PREFIX ?? "",
    });
    return createSnapshotHandler({ snapshots }).fetch(req);
  },
};
```

A host running multi-site under one worker resolves the prefix
per-request (subdomain → site ID → prefix) and constructs
`R2Snapshots` accordingly. A host running multi-environment uses
different bucket bindings per environment (`SITE_BUCKET_DEV`,
`SITE_BUCKET_STAGING`, …) and picks one based on environment context.

A host triggering a build from inside their own worker (e.g.
vibe-coding platform's "deploy" button) calls `deploySite` from a
worker, passing their SiteDO as `Site` and a `WorkerdExecutor` as
the executor. No new code path; same function works in Node and
workerd.

## What lands

### `@astroflare/core` — interface additions

Parallel to Phase 26's `Site` / `Cache`:

```ts
interface SnapshotEntry {
  route: string;          // "/about", "/blog/post-1"
  bytes: Uint8Array;
  contentType: string;    // "text/html;charset=utf-8"
  hash: string;           // sha-256 of bytes
}

interface Snapshots {
  read(snapshotHash: string, route: string): Promise<SnapshotEntry | null>;
  current(): Promise<string | null>;
  list(): Promise<readonly string[]>;
}

interface SnapshotSink {
  put(snapshotHash: string, entry: SnapshotEntry): Promise<void>;
  commit(snapshotHash: string): Promise<void>;     // atomic flip of current
  abort(snapshotHash: string): Promise<void>;      // clean up partial writes
}
```

### `@astroflare/build` — pure functions

Drops:
- `deploy()` (replaced by `buildSite` + `deploySite`).
- `deploy-server.ts` (replaced by `createSnapshotHandler`).

Adds:
- `buildSite({ site, config, executor?, imageService? }): AsyncIterable<SnapshotEntry>` —
  pure stream of source → entries. Runs locally or in-Worker depending
  on which `Executor` (or none, for static-only sites) the host
  passes.
- `deploySite({ site, sink, config, executor? }): Promise<{ snapshotHash, routes }>` —
  convenience wrapper that pipes `buildSite` to a sink and commits.
- `createSnapshotHandler({ snapshots, cacheHeaders? }): { fetch(req): Promise<Response> }` —
  request handler the host's worker calls. Resolves URL → route →
  current snapshot → entry. No Cloudflare-specific imports.
- `LocalSite(dir): Site` — Node-side `Site` adapter for local FS.
  Used by the CLI; reusable.

### `@astroflare/host-cloudflare` — adapters only

Drops:
- `stack-worker.ts` (entrypoint).
- `R2Storage` (the multi-prefix combiner).
- `coordinator-do.ts` / `transport.ts` (already going away in Phase 26;
  noted here for completeness — Mode B never used them either).

Adds:
- `R2Snapshots({ bucket, prefix? })` — implements `Snapshots`.
  Default prefix `""`. Trailing slash on `prefix` is auto-normalized.
- `R2SnapshotSink({ bucket, prefix? })` — implements `SnapshotSink`.
  Same semantics. `commit` writes `<prefix>current` atomically.

Stays:
- `WorkerdExecutor` — shared with Mode A (Phase 26 reshape).

### `@astroflare/cli-lib` — same external behavior, new internals

`deployStaticBundle({ stack, fixtures, client })` reshape:

1. Build a `LocalSite(fixture.dir)`.
2. Build a REST-backed `R2SnapshotSink` (CLI doesn't have an R2
   binding; it talks to the Cloudflare REST API). Convenience
   constructor: `R2SnapshotSink.viaRest({ accountId, apiToken, bucket, prefix })`.
3. `deploySite({ site, sink })`.

External contract — what lands in R2, when `current` flips, what
`af status` reads — is identical. Internals split along the new
boundary.

`af status` / `af rollback` read/write `<prefix>current` via the
same REST-backed `R2Snapshots`. The pointer's wire format is unchanged.

### `@astroflare/cli` — verb map

| Verb | Status |
|---|---|
| `af deploy` / `af deploy-static` | Same external behavior. Internals: `LocalSite` → `buildSite` → `R2SnapshotSink` |
| `af status` / `af rollback` | Same. Reads/writes the current pointer |
| `af provision-stack <n> [--prefix <p>]` | Reshape: provisions the **reference deploy host** worker (below) instead of `stack-worker.ts`. New `--prefix` flag passes through as `SITE_PREFIX` env var |
| `af destroy-stack <n>` | Same. Symmetric teardown |

### `tests/e2e/fixtures/deploy-host-ref/` (new)

Reference Mode B host application. Contents:

- `wrangler.jsonc` — registers the worker with an R2 bucket binding
  and a `SITE_PREFIX` env var.
- `src/worker.ts` — the ~15-line worker shown in the integration
  shape above.
- `aflare.config.json` — fixture config the test suite consumes.

Doubles as the canonical Mode B integration example. Documentation
and `af provision-stack` both reference it.

For multi-site demonstration, `tests/e2e/fixtures/deploy-host-multi-ref/`
extends the pattern: extracts a site ID from the request hostname or
path, constructs a per-site `R2Snapshots` with a derived prefix.
Used in the prefix-isolation e2e assertion (below).

### `tests/e2e/{minimal,basics,deploy-ceremony}.spec.ts`

Pass through unchanged externally — they hit the deployed worker URL,
not the worker source. Internally the harness provisions the
reference host instead of stack-worker.

New assertion in `deploy-ceremony.spec.ts`:
- **Prefix isolation.** Provision two stacks with different prefixes
  (`sites/a/`, `sites/b/`); deploy the same fixture to each; verify
  fetches under prefix A succeed, fetches under a different prefix
  return 404. Proves the layout customization is end-to-end correct.

## Test coverage (per layer)

| Layer | What's tested |
|---|---|
| A — Node | `buildSite` against `MemorySite`; `R2Snapshots`/`R2SnapshotSink` against in-memory R2 stub; `createSnapshotHandler` against `MemorySnapshots`; prefix normalization (`"sites/abc"` vs `"sites/abc/"` vs `""`) |
| B — workerd | `R2Snapshots` against a real R2 binding under workerd pool; current-pointer atomicity across concurrent commits |
| C — Miniflare | Reference deploy host end-to-end: fixture → `buildSite` → `R2SnapshotSink` → flip → handler serves; multi-site prefix routing |
| D — e2e | Reference host fixture deployed to real Cloudflare; existing minimal/basics/deploy-ceremony assertions plus prefix-isolation; build-on-Cloudflare smoke (call `deploySite` from inside a deployed worker, sources from a SiteDO) |

## Migration strategy

Hard cut, staged inside the refactor branch:

1. Land `Snapshots` / `SnapshotEntry` / `SnapshotSink` in `@astroflare/core`.
2. Land `buildSite` / `deploySite` / `createSnapshotHandler` /
   `LocalSite` in `@astroflare/build` (alongside the existing
   `deploy()` for one commit).
3. Land `R2Snapshots` / `R2SnapshotSink` in `@astroflare/host-cloudflare`.
4. Land reference deploy host fixture under
   `tests/e2e/fixtures/deploy-host-ref/`.
5. Switch `tests/e2e/{minimal,basics,deploy-ceremony}.spec.ts` to
   provision the reference host. Add prefix-isolation assertion.
6. Reshape `deployStaticBundle` in `cli-lib` to use the new pipeline.
   External behavior unchanged.
7. Delete `stack-worker.ts`, `scripts/build-stack-worker.mjs`,
   `R2Storage`, `deploy-server.ts`, the legacy `deploy()` exports.
8. Update CLAUDE.md (sharpen the Mode B carve-out language; remove
   stack-worker reference). Update `docs/cloudflare-validation-plan.md`
   noting that build-on-Cloudflare (formerly Phase 22b/22c) is now
   trivially supported via the `Executor` abstraction.

Each step ends green; the suite never goes red between commits.

## Acceptance signals

- `pnpm test` green at every commit.
- `scripts/build-stack-worker.mjs` no longer exists.
- `@astroflare/host-cloudflare` exports zero DO classes and zero
  worker entrypoints — only adapter classes (`R2Snapshots`,
  `R2SnapshotSink`, `WorkerdExecutor`, `SqlCache`).
- `af deploy` / `af status` / `af rollback` external behavior
  unchanged.
- Reference fixture works under a custom prefix (e.g.
  `sites/abc/`) — host deploys under that prefix, fetches under
  it succeed, fetches under a different prefix 404.
- Build-on-Cloudflare is a one-liner: pass `WorkerdExecutor` to
  `buildSite` from inside a host worker. No new code path needed.

## Carve-outs

- **`LocalSnapshotSink` for offline / CI deploys.** A "build to
  local directory" sink (writes `<dir>/<snapshotHash>/<route>` +
  `<dir>/current`) — useful for `af deploy --output-dir ./dist` or
  CI that uploads via a different tool. Not required for this
  phase.
- **Custom cache-header policies.** `createSnapshotHandler` takes
  an optional `cacheHeaders(entry) => Record<string, string>`
  callback. Default policy: HTML `Cache-Control: public, max-age=0,
  must-revalidate`; hashed assets `public, max-age=31536000,
  immutable`. Per-host customization via the option; advanced
  policies (purge-on-deploy, surrogate keys) are host-side.
- **Per-route content negotiation.** Astroflare emits one
  `SnapshotEntry` per route. Compression variants (br/gzip),
  DPR/format variants for images — out of scope here; host's CDN
  handles it.
- **Snapshot retention / garbage collection.** Old snapshots stay
  in storage until the host deletes them. Astroflare exposes
  `Snapshots.list()` so hosts can implement GC; doesn't enforce a
  policy.

## Out of scope

- Any change to Mode A (Phase 26's territory).
- Changes to compiler / runtime / preview-server / content
  packages. Pure framework code, untouched.
- Adding new framework features. Boundary refactor only.

## Order rationale

Phase 26b is independent of Phase 26 except for sharing the `Site`
interface (Phase 26 lands it; 26b consumes it). Recommend landing
26 first (the more visible host integration), then 26b. Both should
ship before v0.1.0 — the published API surface should be the
post-North-Star shape, and we don't want users building against
the deprecated `deploy()` / `stack-worker` surface for one release
just to break them on the next.
