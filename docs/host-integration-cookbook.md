# Host integration cookbook

Astroflare is a library. The host owns its `Workspace`, its `SiteDurableObject`,
its worker entrypoint, and the routing between them. The framework supplies
factories — `createCoordinator`, `createPreviewHandler`, `acceptHmrSocket`,
`SqlCache`, `createWorkerdExecutor`, `WorkspaceSite` — that the host wires
inside its own DO.

This document is the wiring guide. Three worked examples cover the three host
shapes we see in the wild:

1. **[Single-DO host](#example-1--single-do-host).** Workspace, coordinator,
   HMR socket, and preview handler all live in one DO. The reference fixture
   at [`tests/e2e/fixtures/preview-host-ref/`](../tests/e2e/fixtures/preview-host-ref/)
   matches this shape.
2. **[Two-DO host](#example-2--two-do-host-workspace-separated).** Workspace
   in DO A, Astroflare pipeline in DO B. The pattern hosts reach for once they
   want to migrate workspaces independently of the compile cache, or when their
   workspace state is large enough to warrant a dedicated DO.
3. **[Three-DO host](#example-3--three-do-host-with-an-agent).** Workspace +
   pipeline + an external agent DO that drives chat-style writes through the
   workspace. The third DO is opaque to Astroflare — DO A's `onChange` handles
   any write source uniformly.

Each example is type-checkable as written; the `WorkspaceSite` /
`AstroflareCoordinator` calls are the supported public surface.

## Invariants every host must preserve

These are the load-bearing rules. Each example below enforces them explicitly.

### `aflare_hash` is the closure-cache key

`WorkspaceSite` maintains a sidecar `aflare_hash` table in DO sqlite. The
preview handler walks the import closure and looks up each module by its
hash; if the sidecar is stale, the cache returns the **old compiled bytes**
even after the source changed and the HMR socket fires.

The framework keeps this in sync automatically when the host writes through
{@link WorkspaceSite.write}. **Any write path that bypasses
`WorkspaceSite.write` (cross-DO writes, agent-driven writes against the
workspace DO, externally-mounted filesystems) must call
{@link WorkspaceSite.recordExternalWrite} before
`coordinator.notifyChanged`** — otherwise the closure cache key drifts and
preview renders serve stale output.

### `Workspace.onChange → SiteChangeEvent` is a non-trivial mapping

`@cloudflare/shell`'s `Workspace` emits `WorkspaceChangeEvent` of shape
`{ type: "create" | "update" | "delete", path, entryType }`. Astroflare's
`SiteChangeEvent` is `{ kind: "write" | "delete", path, hash }`. The
mapping rules:

- `create` and `update` both map to `kind: "write"`. The framework cares
  about "this path now has new bytes," not about whether it existed before.
- `delete` maps to `kind: "delete"`.
- **Filter `entryType !== "file"`.** Directories and symlinks aren't
  framework-relevant; firing `notifyChanged` for them invalidates the
  closure cache for nothing.
- The `hash` field on `kind: "write"` events is the SHA-256 of the new
  bytes. `WorkspaceChangeEvent` doesn't include bytes — read them back
  through the workspace and hash them, or call `recordExternalWrite`
  (which does this for you).

### Hibernatable WebSocket lifecycle

`acceptHmrSocket` calls `ctx.acceptWebSocket(server, ["aflare-hmr"])` — the
Hibernatable WS API. The DO can hibernate while sockets remain attached;
when traffic wakes it, Cloudflare calls `webSocketMessage` and
`webSocketClose` on the DO instance. The host's DO must override these and
delegate to the coordinator:

```ts
override webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): void {
  this.#coordinator.webSocketMessage(ws, msg);
}
override webSocketClose(ws: WebSocket, code: number): void {
  this.#coordinator.webSocketClose(ws, code);
}
```

Forgetting these is silent: connections still upgrade, but the coordinator
never sees the close events, the DO never hibernates cleanly, and stale
sockets accumulate until the DO is evicted.

### Path-prefixing the HMR client

The HMR client connects to an absolute path: `/_aflare/hmr`. Hosts that
mount preview at a non-root prefix (e.g. `/s/:siteId/`) have two options:

- Proxy `/_aflare/hmr` at the same origin, so the absolute path resolves
  to the matching SiteDO; or
- Pass `hmr: { socketPath: "/s/<siteId>/_aflare/hmr" }` to
  `createPreviewHandler` so the injected client opens its WebSocket
  against the prefixed path. This is the simpler shape when the site
  identity is part of the URL path.

`createPreviewHandler` injects the HMR client by default — there's no
extra wiring on the host's side beyond exposing the WS endpoint at
whatever path the client expects. Pass `hmr: false` to skip injection
entirely (useful for static-snapshot previews that don't need live
reload).

## Example 1 — Single-DO host

The simplest topology. One DO per site holds the workspace, the
Astroflare pipeline, the HMR socket, and the preview handler. The
`Workspace.onChange → notifyChanged` wiring is straight-line.

```ts
// site-do.ts
import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/shell";
import {
  type AstroflareCoordinator,
  acceptHmrSocket,
  createCoordinator,
  createPreviewHandler,
  createWorkerdExecutor,
  SqlCache,
  WorkspaceSite,
} from "@astroflare/host-cloudflare";

interface Env {
  SITE_R2: R2Bucket;
  LOADER: WorkerLoader;
}

export class SiteDurableObject extends DurableObject<Env> {
  #site: WorkspaceSite;
  #coordinator: AstroflareCoordinator;
  #cache: SqlCache;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const ws = new Workspace({
      sql: ctx.storage.sql,
      r2: env.SITE_R2,
      name: () => "site",
      onChange: async (e) => {
        // Filter non-file entries early — directories and symlinks
        // never affect the compile closure.
        if (e.entryType !== "file") return;
        if (e.type === "delete") {
          const { event } = await this.#site.recordExternalDelete(e.path);
          await this.#coordinator.notifyChanged(event);
          return;
        }
        // create + update both map to kind: "write".
        const recorded = await this.#site.recordExternalWrite(e.path);
        if (recorded) await this.#coordinator.notifyChanged(recorded.event);
      },
    });

    this.#site = new WorkspaceSite({ workspace: ws, sql: ctx.storage.sql });
    this.#cache = new SqlCache(ctx.storage.sql);
    this.#coordinator = createCoordinator({
      sql: ctx.storage.sql,
      site: this.#site,
      ctx,
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/_aflare/hmr") {
      return acceptHmrSocket(this.ctx, req, this.#coordinator);
    }

    return createPreviewHandler({
      site: this.#site,
      coordinator: this.#coordinator,
      executor: createWorkerdExecutor({
        loader: this.env.LOADER,
        compatibilityDate: "2025-09-01",
        compatibilityFlags: ["nodejs_compat"],
      }),
      cache: this.#cache,
    }).fetch(req);
  }

  override webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): void {
    this.#coordinator.webSocketMessage(ws, msg);
  }
  override webSocketClose(ws: WebSocket, code: number): void {
    this.#coordinator.webSocketClose(ws, code);
  }
}
```

**Why `recordExternalWrite` and not `WorkspaceSite.write` here?** The
`Workspace` itself wrote the bytes — we're inside its `onChange` callback.
Calling `WorkspaceSite.write(path, bytes)` from here would re-write the
file (an extra DO sqlite + R2 round-trip) and re-fire `onChange` (a
write-feedback loop). `recordExternalWrite` keeps `aflare_hash` in step
without touching the workspace.

If the host has a tool that writes through Astroflare (e.g. a
`POST /_aflare/site/file` endpoint that the framework wires end-to-end),
it can use `WorkspaceSite.write` instead; the `onChange` callback then
becomes a no-op for that path because the sidecar is already up to date
(the duplicate `recordExternalWrite` rehashes to the same value and
`notifyChanged` is idempotent on hash equality at the closure level).

## Example 2 — Two-DO host (workspace separated)

When the workspace state is large or has a different lifecycle than the
compile cache (snapshot rotation, multi-tenant scaling), splitting it into
its own DO keeps the boundaries clean. The Astroflare pipeline DO holds
no source bytes — it reads through a cross-DO proxy that satisfies
`WorkspaceLike`.

```ts
// workspace-do.ts — DO A
import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/shell";

interface WorkspaceEnv {
  SITE_R2: R2Bucket;
  ASTROFLARE: DurableObjectNamespace; // points at AstroflareDurableObject
}

export class WorkspaceDurableObject extends DurableObject<WorkspaceEnv> {
  #ws: Workspace;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);
    this.#ws = new Workspace({
      sql: ctx.storage.sql,
      r2: env.SITE_R2,
      name: () => "site",
      onChange: async (e) => {
        if (e.entryType !== "file") return;
        // Forward the change into the Astroflare pipeline DO.
        // The pipeline DO is responsible for rehashing + notifying.
        const id = env.ASTROFLARE.idFromName(this.ctx.id.toString());
        await env.ASTROFLARE.get(id).fetch("https://internal/_change", {
          method: "POST",
          body: JSON.stringify({ type: e.type, path: e.path }),
        });
      },
    });
  }

  // RPC surface the pipeline DO calls back through.
  async readFileBytes(path: string): Promise<Uint8Array | null> {
    return this.#ws.readFileBytes(path);
  }
  async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
    return this.#ws.writeFileBytes(path, bytes);
  }
  async deleteFile(path: string): Promise<boolean> {
    return this.#ws.deleteFile(path);
  }
  async stat(path: string): Promise<{ size: number } | null> {
    return this.#ws.stat(path);
  }
  async glob(pattern: string): Promise<readonly { path: string }[]> {
    return this.#ws.glob(pattern);
  }
}
```

```ts
// astroflare-do.ts — DO B
import { DurableObject } from "cloudflare:workers";
import {
  type AstroflareCoordinator,
  type WorkspaceLike,
  acceptHmrSocket,
  createCoordinator,
  createPreviewHandler,
  createWorkerdExecutor,
  SqlCache,
  WorkspaceSite,
} from "@astroflare/host-cloudflare";

interface AstroflareEnv {
  WORKSPACE: DurableObjectNamespace;
  LOADER: WorkerLoader;
}

/**
 * `WorkspaceLike` is structurally typed — any object with the right
 * methods works. Here we stub-forward each call into the workspace DO.
 */
function workspaceProxy(stub: DurableObjectStub): WorkspaceLike {
  return {
    readFileBytes: (p) => stub.readFileBytes(p) as Promise<Uint8Array | null>,
    writeFileBytes: (p, b) => stub.writeFileBytes(p, b) as Promise<void>,
    deleteFile: (p) => stub.deleteFile(p) as Promise<boolean>,
    stat: (p) => stub.stat(p) as Promise<{ size: number } | null>,
    glob: (pat) => stub.glob(pat) as Promise<readonly { path: string }[]>,
  };
}

export class AstroflareDurableObject extends DurableObject<AstroflareEnv> {
  #site: WorkspaceSite;
  #coordinator: AstroflareCoordinator;
  #cache: SqlCache;

  constructor(ctx: DurableObjectState, env: AstroflareEnv) {
    super(ctx, env);
    const wsId = env.WORKSPACE.idFromName(ctx.id.toString());
    const wsStub = env.WORKSPACE.get(wsId);
    this.#site = new WorkspaceSite({
      workspace: workspaceProxy(wsStub),
      sql: ctx.storage.sql,
    });
    this.#cache = new SqlCache(ctx.storage.sql);
    this.#coordinator = createCoordinator({
      sql: ctx.storage.sql,
      site: this.#site,
      ctx,
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Cross-DO change feed from DO A. Translate to a SiteChangeEvent
    // and refresh the hash sidecar before notifying the pipeline.
    if (url.pathname === "/_change" && req.method === "POST") {
      const { type, path } = (await req.json()) as {
        type: "create" | "update" | "delete";
        path: string;
      };
      if (type === "delete") {
        const { event } = await this.#site.recordExternalDelete(path);
        await this.#coordinator.notifyChanged(event);
      } else {
        const recorded = await this.#site.recordExternalWrite(path);
        if (recorded) await this.#coordinator.notifyChanged(recorded.event);
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/_aflare/hmr") {
      return acceptHmrSocket(this.ctx, req, this.#coordinator);
    }

    return createPreviewHandler({
      site: this.#site,
      coordinator: this.#coordinator,
      executor: createWorkerdExecutor({
        loader: this.env.LOADER,
        compatibilityDate: "2025-09-01",
        compatibilityFlags: ["nodejs_compat"],
      }),
      cache: this.#cache,
    }).fetch(req);
  }

  override webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): void {
    this.#coordinator.webSocketMessage(ws, msg);
  }
  override webSocketClose(ws: WebSocket, code: number): void {
    this.#coordinator.webSocketClose(ws, code);
  }
}
```

**Two things to notice.** First: the pipeline DO doesn't write to the
workspace at all — every read goes through the proxy, every notification
comes from DO A's `onChange`. That's why `recordExternalWrite` (and not
`WorkspaceSite.write`) is the right helper here — the pipeline isn't the
write source.

Second: the cross-DO `/_change` request is fire-and-forget from DO A's
side, but the pipeline DO awaits it. That's deliberate — the HMR socket
broadcast inside `notifyChanged` should fire from the pipeline DO's
isolate, where the WebSockets are attached. If DO A swallowed the response
without awaiting, the workspace write would race the HMR fan-out, and the
browser could re-render against stale cache.

## Example 3 — Three-DO host with an agent

Adds an external agent DO (chat history, scheduled actions, agent state)
that drives writes against the workspace. The agent doesn't know about
Astroflare — it talks to DO A's RPC surface, and DO A's `onChange` handles
the change-pipeline wiring exactly like Example 2. The third DO is opaque
to the framework.

```ts
// agent-do.ts — DO C
import { DurableObject } from "cloudflare:workers";

interface AgentEnv {
  WORKSPACE: DurableObjectNamespace;
}

export class AgentDurableObject extends DurableObject<AgentEnv> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/chat" && req.method === "POST") {
      const { siteId, prompt } = (await req.json()) as {
        siteId: string;
        prompt: string;
      };

      // ... agent decides to write a file based on the prompt ...
      const path = "/src/pages/index.astro";
      const bytes = new TextEncoder().encode("---\n---\n<h1>Hello</h1>\n");

      const wsId = this.env.WORKSPACE.idFromName(siteId);
      await this.env.WORKSPACE.get(wsId).writeFileBytes(path, bytes);

      // The pipeline DO (DO B) hears about this write through DO A's
      // onChange callback — agent doesn't import @astroflare/* at all.
      return Response.json({ wrote: path });
    }

    return new Response("not found", { status: 404 });
  }
}
```

DO A and DO B are unchanged from [Example 2](#example-2--two-do-host-workspace-separated).
The agent's write lands in `Workspace.writeFileBytes`, which fires
`onChange`, which forwards into DO B, which calls `recordExternalWrite`
+ `notifyChanged`. The HMR socket fans out to the browser.

The point of this example: **the change pipeline doesn't care who wrote
the bytes.** As long as every write source funnels through `Workspace`,
DO A's `onChange` is the single integration point. The agent stays
decoupled; the cookbook layout for DO A and DO B doesn't change as you
add more write sources.

## What `createPreviewHandler` does for you

The worker preview handler is the canonical complete preview surface for
hosts running on `@astroflare/host-cloudflare`. Two defaults that hosts
usually shouldn't have to rebuild:

### HMR client injection (`hmr` option)

Every HTML response gets a `<script type="module">` block with the
browser-side HMR client inlined. The client opens a WebSocket against
`/_aflare/hmr` (default) and reloads the page on any `update` / `prune`
/ `full-reload` message. Hosts that mount preview at a non-root prefix
should pass a `hmr.socketPath` so the WS URL is rooted at the right
place:

```ts
createPreviewHandler({
  site,
  coordinator,
  executor,
  cache,
  hmr: { socketPath: `/s/${siteId}/_aflare/hmr` },
});
```

Pass `hmr: false` to skip injection entirely (e.g. when serving rendered
pages outside an iframe context where HMR isn't useful). The injected
script is the same client `installHmrClient` exports for direct use; the
underlying source builder is `buildHmrClientSource({ socketPath })` from
`@astroflare/runtime` — useful when a host wants to ship the script at
its own URL instead of inlining.

### `/public/*` static assets (`publicAssets` option)

Mirrors standard Astro's
[`public/`](https://docs.astro.build/en/basics/project-structure/#public)
convention. A request for `/logo.png` falls through to
`/public/logo.png` in the workspace if no route matches; the bytes are
served verbatim with an extension-derived content-type. Path traversal
(`..`) is rejected up front so the fallback can't escape `/public/`.

`buildSite` (both Node and workers-runtime entries) emits matching
`SnapshotEntry`s under the same routes, so the published snapshot has
the same set of bytes preview serves. Pass `publicAssets: false` on
either side to opt out (for hosts shipping public assets through a
separate CDN pipeline).

The `mimeForPath(pathOrExt)` helper that backs both the preview
fallback and the snapshot walk is exported from `@astroflare/core` for
hosts that want to use the same content-type mapping in their own code.

## Verifying your wiring

Astroflare ships two diagnostic helpers on the coordinator that let you
verify the change pipeline is firing without spinning up a browser.

```ts
// 1. After a write, check the most-recent HMR event:
const events = coordinator.recentHmrEvents();
const last = events.at(-1)?.message;
if (!last || last.type !== "update" || last.trigger !== "/src/pages/index.astro") {
  throw new Error("HMR did not fire for /src/pages/index.astro");
}

// 2. In a unit test, drive a synthetic change without a real Workspace:
await coordinator.simulateChange({
  kind: "write",
  path: "/src/pages/index.astro",
  hash: "abc123",
});
const seen = coordinator.recentHmrEvents();
console.assert(seen.length === 1);
```

`recentHmrEvents` is best-effort across DO eviction — the buffer is
in-isolate JS state and resets on hibernation. Capped at 32 entries by
default; pass a smaller `limit` to get just the tail.

`simulateChange` is a thin alias over `notifyChanged` — same fan-out, same
ring-buffer effect, just a more intent-readable entry point for tests.

## Negative tests worth writing

The most common HMR-wiring bug is "I called `notifyChanged` but the
preview is still stale." It's almost always a missing `recordExternalWrite`.
A regression test that proves the helper is doing real work:

```ts
// 1. Write bytes directly through the workspace (bypass site.write).
await ws.writeFileBytes("/src/pages/index.astro", v1);
// 2. Compute the hash sidecar.
await site.recordExternalWrite("/src/pages/index.astro");
// 3. Render — should see v1.
const r1 = await preview.fetch("https://x/").then((r) => r.text());

// 4. Write v2, but DO NOT call recordExternalWrite this time.
await ws.writeFileBytes("/src/pages/index.astro", v2);
await coordinator.notifyChanged({
  kind: "write",
  path: "/src/pages/index.astro",
  hash: "wrong-hash", // simulate a host that hashed v1's bytes
});
// 5. Render — without recordExternalWrite, the closure cache key drifts.
//    The render serves stale compiled bytes.
const r2 = await preview.fetch("https://x/").then((r) => r.text());
console.assert(r2.includes(/* v1 marker */), "stale render proves the invariant");
```

That test doubles as the rationale for `recordExternalWrite`'s existence:
the helper is the boundary that keeps `aflare_hash` and the compile
cache in lock-step.

## Compile-error recovery — keep the iframe alive

The host-side workaround Ember shipped (`AstroflareHost` runs
`ModuleGraph.compile` against incoming bytes and substitutes an HMR
`error` for `update` on failure) is now built in. Two pieces:

1. **Wire the framework's compiler into the coordinator** so the
   pre-flight runs at `notifyChanged` time:

   ```ts
   import { ModuleGraph } from "@astroflare/preview/module-graph";

   const moduleGraph = new ModuleGraph(
     { site, cache, coordinator },
     { runtimeImport: "./runtime/index.js" },
   );

   const coordinator = createCoordinator({
     sql,
     compile: async (path) => {
       await moduleGraph.compile(path);
     },
   });
   ```

2. **Pass `verifyCompile: true` from your write path** so the
   coordinator drives the pre-flight before deciding what to publish:

   ```ts
   await coordinator.notifyChanged(
     { kind: "write", path, hash },
     { verifyCompile: true },
   );
   ```

   On a clean compile the historical `update` walk runs unchanged.
   On a `CompileError` the broadcast becomes
   `{ type: "error", error: { message, path, line, column, codeFrame, diagnostics, ... } }`
   — the connected iframe stays on the previous good render and the
   auto-injected client surfaces a modal overlay with the code frame.

The pre-flight is strictly opt-in; embedders that don't pass
`verifyCompile` get the historical behaviour and can flip the flag on
when they're ready. `createPreviewHandler` independently wraps every
500/404 in an HTML envelope that re-injects the HMR client `<script>`
(gated only by `hmr !== false`) so a manual reload onto a broken page
still gets a live socket.
