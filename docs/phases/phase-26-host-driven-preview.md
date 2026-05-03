# Phase 26 — Host-driven preview architecture (Mode A refactor)

**Goal:** flip Mode A from "Astroflare-owned worker that holds your
files" to "Astroflare-as-library a host application invokes." The
host owns the SiteDurableObject, the Workspace, and the worker.
Astroflare contributes zero DO classes and zero entrypoints — only
interfaces and request-handling functions.

This is a refactor, not a feature add. The framework gets smaller;
the surface gets cleaner; the architecture matches the brief's
principle that Astroflare is a library, not an application.

**Status:** planned 2026-05-03. Supersedes the previously-planned
Phase 26 (dual-mode parity); that work renumbers to Phase 27 and
runs against the architecture this phase lands.

## Why now

Phase 25 shipped a working preview worker: `provision-preview`
provisions a stack, `upload-files` POSTs source files into R2, the
preview worker compiles + renders. It works, but the boundary is
wrong — Astroflare owns the DOs, the storage, and the entrypoint.
A host application (e.g. a vibe-coding agent that hosts user-edited
Astroflare sites) inherits an Astroflare-shaped runtime instead of
being given an Astroflare-shaped library.

Recent context that forced the rethink:
- `@cloudflare/shell` provides `Workspace` — a DO-sqlite-backed
  POSIX filesystem the host can instantiate inside any DO it owns.
- Vibe-coding hosts want a SiteDO that holds: workspace, identity,
  config, application state. That's per-site state the host owns.
- Astroflare living in a separate DO with its own storage means
  two competing sources of file state. Can't work.

The fix is to move Astroflare's storage / coordinator / transport
responsibilities into the host's DO via composition. Astroflare
provides factories the host calls inside its DO constructor.
Astroflare provides a request-handler factory the host's worker
calls. Astroflare ships zero DOs.

## Recorded design decisions

Settled in conversation 2026-05-03 before the plan was drafted:

| Decision | Choice |
|---|---|
| Module graph storage | Inside host's SiteDO sqlite, prefixed `aflare_*` |
| HMR endpoint | Host's SiteDO is the WS endpoint; Astroflare provides protocol functions |
| Change pipeline | Host wires `workspace.onChange` → `coordinator.notifyChanged(event)` |
| Cache keyspace | `SqlCache` — `aflare_cache` table in host SiteDO sqlite (Mode A only; Mode B never used the cache keyspace) |
| WorkspaceSite adapter | Separate package `@astroflare/site-workspace`; keeps `@cloudflare/shell` out of `@astroflare/host-cloudflare` |
| Migration | Hard cut. No existing users. Drop CoordinatorDO, HmrDO, preview-worker entrypoint outright |
| Reference host | Lives at `tests/e2e/fixtures/preview-host-ref/`; e2e suite provisions it; serves as the canonical integration example |
| Mode B (deploy) | Untouched. Stack-worker, R2 site artifacts, deploy ceremony all keep current shape |

## Integration shape (host-side)

What a host application looks like after this phase. Roughly 30 LOC.

```ts
// host's site-do.ts
import { Workspace } from "@cloudflare/shell";
import {
  createCoordinator,
  createPreviewHandler,
  acceptHmrSocket,
  SqlCache,
  createWorkerdExecutor,
} from "@astroflare/host-cloudflare";
import { WorkspaceSite } from "@astroflare/site-workspace";

export class SiteDurableObject extends DurableObject<Env> {
  #ws: Workspace;
  #site: WorkspaceSite;
  #coordinator: ReturnType<typeof createCoordinator>;
  #cache: SqlCache;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ws = new Workspace({ sql: ctx.storage.sql, r2: env.SITE_R2 });
    this.#site = new WorkspaceSite(this.#ws, ctx.storage.sql);
    this.#cache = new SqlCache(ctx.storage.sql);
    this.#coordinator = createCoordinator({
      sql: ctx.storage.sql,
      site: this.#site,
      ctx,
    });
    this.#ws.onChange((e) => this.#coordinator.notifyChanged(e));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/_aflare/hmr") {
      return acceptHmrSocket(this.ctx, req, this.#coordinator);
    }
    return createPreviewHandler({
      site: this.#site,
      coordinator: this.#coordinator,
      executor: createWorkerdExecutor({ loader: this.env.LOADER }),
      cache: this.#cache,
    }).fetch(req);
  }

  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    return this.#coordinator.webSocketMessage(ws, msg);
  }
  webSocketClose(ws: WebSocket, code: number) {
    return this.#coordinator.webSocketClose(ws, code);
  }
}
```

The host's root worker is even smaller — it picks a SiteDO ID per
request and calls `stub.fetch(req)`. Routing strategy is the host's
choice (subdomain, path prefix, JWT claim, whatever fits their app).

## What lands

### `@astroflare/core` — interface compression

New interfaces:

```ts
interface Site {
  readFile(path: string): Promise<Uint8Array | null>;
  statFile(path: string): Promise<{ size: number; hash: string } | null>;
  glob(pattern: string): AsyncIterable<string>;
  subscribe(listener: (e: SiteChangeEvent) => void): Subscription;
}

type SiteChangeEvent =
  | { kind: "write"; path: string; hash: string }
  | { kind: "delete"; path: string };

interface Cache {
  get(hash: string): Promise<Uint8Array | null>;
  put(hash: string, bytes: Uint8Array): Promise<void>;
}
```

`Coordinator` becomes a *factory* contract — `createCoordinator()`
returns an in-DO object with `notifyChanged`, `graphGet`, `graphPut`,
`webSocketMessage`, `webSocketClose`, plus the helpers the preview
handler needs. Not a DO class, not an interface implemented by a DO.

`Host` compresses from `{ storage, executor, coordinator, transport,
clock, logger, ... }` to `{ site, coordinator, executor, cache,
clock, logger, ... }`.

Drop: `Storage` interface (the file/cache combination); `Transport`
interface (becomes the protocol functions in `acceptHmrSocket` +
coordinator delegate methods).

### `@astroflare/host-cloudflare` — library, not entrypoint

Drops:
- `coordinator-do.ts` (DO class)
- `transport.ts` (HmrDurableObject)
- `preview-worker.ts` (entrypoint)
- `r2-storage.ts` cache-keyspace methods (Mode B's deploy artifact
  paths use a different layout)

Adds:
- `createCoordinator({ sql, site, ctx, cache? })` — runs in-process
  inside any DO. Owns module graph + change pipeline + WS subscription
  state. Auto-creates `aflare_*` tables on first call (idempotent
  CREATE TABLE IF NOT EXISTS, schema versioned via
  `aflare_schema_version`).
- `createPreviewHandler({ site, coordinator, executor, cache? })` —
  returns a request handler the host's worker (or DO) calls. Handles
  `GET /<route>` (compile + render). Stateless beyond what the
  coordinator provides.
- `acceptHmrSocket(ctx, request, coordinator)` — for HMR WS upgrade.
  Calls `ctx.acceptWebSocket(socket, ["aflare-hmr"])`; coordinator
  routes hibernation-aware messages.
- `SqlCache(sql)` — default Cache implementation backed by
  `aflare_cache` table.
- `createWorkerdExecutor({ loader, runtime })` — small reshape of
  existing `WorkerdExecutor` to take an explicit runtime-modules
  map (was implicit via build-time substitution).

R2-backed storage stays for Mode B as `R2DeployStore` — only the
files keyspace, no cache keyspace.

### `@astroflare/site-workspace` (new package)

Single export: `WorkspaceSite` — implements `Site` against
`@cloudflare/shell`'s `Workspace`. Maintains a sidecar
`aflare_hash` table to satisfy `statFile.hash` cheaply (compute
SHA-256 on every write; read from sidecar on stat). Translates
Workspace's `onChange` events to `SiteChangeEvent`.

Depends on `@cloudflare/shell` (not in framework deps). Hosts opt
in by installing this package; hosts using a different filesystem
write their own `Site` adapter and skip this package.

### `@astroflare/cli` / `@astroflare/cli-lib`

Removes (preview is host-owned now):
- `af provision-preview`
- `af destroy-preview`
- `af upload-files`

Keeps unchanged (Mode B):
- `af deploy` / `af status` / `af rollback`
- `af provision-stack` / `af destroy-stack` / `af deploy-static`
- `af list` / `af inspect` / `af health` / `af gc` / `af destroy-all`

The introspection gaps from the prior audit (`inspect`/`list`/
`health` ignoring stack/preview entries, no deploy history, no
log tail) get fixed in Phase 26b — independent, rides along.

### `tests/e2e/fixtures/preview-host-ref/` (new)

A reference vibe-coding-style host application demonstrating the
integration pattern:

- `wrangler.jsonc` — registers `SiteDurableObject` with
  `new_sqlite_classes` migration, R2 binding for Workspace
  spillover, Worker Loader binding.
- `src/site-do.ts` — the `SiteDurableObject` example shown above.
- `src/worker.ts` — root worker that resolves SiteDO IDs from
  request URL and forwards `stub.fetch(req)`.
- `files/` — minimal Astroflare project (a couple of `.astro`
  pages) the e2e suite uploads into the SiteDO via direct DO
  RPC.

Doubles as the canonical integration example. Documentation
references this fixture directly when explaining host integration.

### `tests/e2e/preview.spec.ts`

Reframes against the reference host. Same six assertions from
Phase 25 (diagnostic info, render, 404, auth, file write,
rewrite-then-fetch), now driven through the host worker URL
instead of `provision-preview`'s output. The setup provisions
the reference-host bundle.

Three new assertions enabled by the new architecture:
- **HMR roundtrip** — open WS to `/_aflare/hmr`, write a file via
  the host's RPC, receive `update` message. Was deferred under
  Phase 25 because the WS path was indirect.
- **Workspace introspection** — `getWorkspaceInfo()` round-trip
  via a host-exposed diagnostic.
- **File deletion** — host calls `coordinator.onFileRemoved`,
  receives `prune` HMR message.

## Test coverage (per layer)

| Layer | What's tested |
|---|---|
| A — Node | `createCoordinator` against `MemorySite` + better-sqlite3; `SqlCache` round-trip; module-graph reverse edges; cross-package interface contracts |
| B — workerd | Coordinator running inside a real DO; WS hibernation across simulated isolate cycle; `aflare_*` table migrations |
| C — Miniflare | Reference-host SiteDO end-to-end: write → render → HMR; `WorkspaceSite` adapter against Miniflare's Workspace + R2 |
| D — e2e | Reference-host fixture deployed to real Cloudflare; Phase 25's six assertions plus three new ones |

## Migration strategy

Hard cut, but staged inside the refactor branch so each commit
stays green:

1. Land new interfaces in `@astroflare/core` alongside old ones
   (typed deprecation, both compile).
2. Land `createCoordinator`, `createPreviewHandler`,
   `acceptHmrSocket`, `SqlCache`, `createWorkerdExecutor` in
   `@astroflare/host-cloudflare`. Land `@astroflare/site-workspace`.
3. Land reference-host fixture under
   `tests/e2e/fixtures/preview-host-ref/`.
4. Switch `tests/e2e/preview.spec.ts` to the reference host.
5. Delete `coordinator-do.ts`, `transport.ts`,
   `preview-worker.ts`, the three CLI verbs, the deprecated
   framework interfaces, and `scripts/build-preview-worker.mjs`.
6. Update `CLAUDE.md` (CLI surface, test layer C description,
   project shape diagram). Update
   `docs/dual-mode-validation-plan.md` (renumber Phase 26 →
   Phase 27, note the architecture change). Update
   `docs/next-phases.md` (point to this plan).

Each step ends green; the suite never goes red between commits.

## Acceptance signals

- `pnpm test` green at every commit on the refactor branch.
- `pnpm build:preview-worker` no longer exists (no preview-worker
  bundle to build).
- `tests/e2e/preview.spec.ts` runs against the reference-host
  fixture; all assertions green on real Cloudflare.
- `@astroflare/host-cloudflare` exports `createCoordinator`,
  `createPreviewHandler`, `acceptHmrSocket`, `SqlCache`,
  `createWorkerdExecutor`, `R2DeployStore`. Does not export DO
  classes or worker entrypoints.
- `@astroflare/site-workspace` is a separately-published package
  depending on `@cloudflare/shell`.
- A user reading `tests/e2e/fixtures/preview-host-ref/` can copy
  it into their own repo and have a working
  Astroflare-on-Cloudflare integration without `af
  provision-preview`.

## Carve-outs (deferred)

- **Phase 26b — CLI introspection upgrades.** Fix `inspect` /
  `list` / `health` for stack entries; add `af logs` / `af tail`
  (Phase 20b carryover). Independent of the architecture
  refactor; rides along when convenient.
- **Phase 27 — dual-mode parity.** The previously-planned
  Phase 26. Runs against the new architecture: same fixture
  through preview-host-ref and through Mode B's
  `deployStaticBundle`, asserts structural HTML equivalence.
- **Multi-site routing.** The reference fixture is single-site
  (one SiteDO ID). Multi-site routing (host maps URLs → DO IDs)
  is a host concern; the framework adds nothing.
- **Asset pipeline reshape.** `<Image>` runtime works against the
  `Site` interface today via raw reads; the asset pipeline
  (Phase 13) doesn't get reshaped here.
- **Promotion to `examples/`.** The reference fixture lives under
  `tests/e2e/fixtures/` for now (per recorded decision). Promoting
  it to a top-level `examples/preview-host/` subpackage so users
  can install it directly is a documentation-pass concern, not
  this phase.

## Out of scope

- Any change to Mode B (deploy → R2 → stack-worker). Independent
  lifecycle, untouched.
- Changes to compiler / runtime / preview-server / build /
  content packages. Pure framework code that doesn't know about
  Cloudflare.
- Adding new framework features. This is a boundary refactor,
  not a feature add.

## Order rationale

This phase blocks Phase 27 (parity) — the parity test needs both
modes pointing at the same fixture, and Mode A's fixture format
changes here. It also blocks publishing v0.1.0 — the published
API surface should be the *new* shape, not the deprecated
DO-classes-and-entrypoint shape, because the published API is
what users build against and we don't want to ship two
architectures. Therefore: this phase precedes everything in the
Phase 24b release-readiness checklist.
