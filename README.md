# Astroflare

Cloudflare-native, Astro-compatible content framework.

Run an Astro-shaped project (`src/pages/`, `.astro` / `.md` / `.mdx`,
`astroflare.config.*`) on Cloudflare's isolate primitives — live
preview with HMR + production-deploy snapshots, no Node, no Vite,
no native code anywhere.

## How it fits — the boundary

Astroflare is a **library**, not an application. Your host
application brings everything stateful; Astroflare provides
narrow capabilities and request-handler factories.

- **Zero Astroflare-owned Durable Objects.** Your DO holds state;
  Astroflare gives you factories you call inside its constructor.
- **Zero canonical worker entrypoint.** You write the worker;
  Astroflare gives you handler factories.
- **Storage is yours.** Pass a `Site` (read-only file capability)
  + a `Cache` (compile cache); Astroflare uses them.
- **Astroflare's internal state** (module graph, compile cache)
  lives in your DO sqlite under the `aflare_*` table prefix.

The full architectural rationale is in
[`CLAUDE.md`](./CLAUDE.md) under "Architectural North Star."

## Two modes

| Mode | Purpose | Lifecycle |
|---|---|---|
| **A — Preview** | Live editing with HMR; in-Worker compile + render. | Source files in a host-owned `SiteDurableObject`'s `Workspace`; renders on demand via Worker Loader. *Paid plan only.* |
| **B — Deploy** | Production. Pre-rendered, atomically-flippable snapshots. | `buildSite` runs locally / in CI; output lands in R2 as a versioned snapshot; a slim worker serves it. |

The same `.astro` source flows through both. The
[`tests/e2e/parity.spec.ts`](./tests/e2e/parity.spec.ts) asserts the
two modes produce structurally equivalent HTML.

## Quick start — Mode B (production deploy)

The deploy worker is ~15 lines. Mount the snapshot handler over an
R2 binding:

```ts
// src/worker.ts
import { createSnapshotHandler } from "@astroflare/build";
import { R2Snapshots } from "@astroflare/host-cloudflare";

interface Env {
	SITE_BUCKET: R2Bucket;
	SITE_PREFIX?: string;  // "" or "sites/<id>/" for multi-site
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

Deploy a fixture:

```sh
af provision-stack myapp           # one-time: provision worker + R2
af deploy-static ./my-site --stack myapp   # compile + ship a snapshot
```

The framework compiles + renders locally, writes one
`SnapshotEntry` per route into R2 under
`<prefix><snapshotHash>/<route-key>`, then atomically flips
`<prefix>current`.

Working reference: [`tests/e2e/fixtures/deploy-host-ref/`](./tests/e2e/fixtures/deploy-host-ref/).

## Quick start — Mode A (preview)

The preview host is ~30 lines. Wire `@cloudflare/shell`'s
`Workspace` + Astroflare's coordinator + handler inside your
SiteDO:

```ts
// src/site-do.ts
import { Workspace } from "@cloudflare/shell";
import {
	type AstroflareCoordinator,
	acceptHmrSocket,
	createCoordinator,
	createPreviewHandler,
	createWorkerdExecutor,
	SqlCache,
} from "@astroflare/host-cloudflare";
import { WorkspaceSite } from "@astroflare/site-workspace";

interface Env { SITE_R2: R2Bucket; LOADER: WorkerLoader }

declare const __AFLARE_RUNTIME_MODULES__: Record<string, string>;

export class SiteDurableObject extends DurableObject<Env> {
	#site: WorkspaceSite;
	#coordinator: AstroflareCoordinator;
	#cache: SqlCache;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const ws = new Workspace({ sql: ctx.storage.sql, r2: env.SITE_R2 });
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
				runtime: __AFLARE_RUNTIME_MODULES__,
			}),
			cache: this.#cache,
		}).fetch(req);
	}

	override webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
		this.#coordinator.webSocketMessage(ws, msg);
	}
	override webSocketClose(ws: WebSocket, code: number) {
		this.#coordinator.webSocketClose(ws, code);
	}
}
```

Files mutate via your own POST endpoint that calls
`workspaceSite.write(path, bytes)` then
`coordinator.notifyChanged(event)` — that drives HMR fanout to
connected browsers automatically.

Working reference: [`tests/e2e/fixtures/preview-host-ref/`](./tests/e2e/fixtures/preview-host-ref/)
(includes the bundling script that inlines runtime modules into
`__AFLARE_RUNTIME_MODULES__`).

## Multi-environment, multi-site

`R2Snapshots({ bucket, prefix })` handles partitioning. A
vibe-coding platform with three environments + many sites:

```ts
// production deploy worker, per-request
const snapshots = new R2Snapshots({
	bucket: env.SITE_BUCKET_PROD,        // dev/staging/prod = different bindings
	prefix: `sites/${extractSiteId(req)}/`,  // multi-site partitioning
});
```

The same pattern works for the preview SiteDO via
`Workspace`'s `namespace` argument.

## CLI (`af`)

Agent-driven ops surface — JSON-first output, structured errors.

| Verb | What |
|---|---|
| `af doctor` | Environment sanity check (creds, plan, state). |
| `af provision-stack <n>` / `af destroy-stack <n>` | Provision the reference deploy host worker + R2. |
| `af deploy [dir]` / `af deploy-static <dir>` | Compile + render locally, ship a snapshot. |
| `af status` / `af rollback <hash>` | Active snapshot / flip to a previous one. |
| `af snapshot list <stack> [--prefix <p>]` | All snapshots; marks active. |
| `af snapshot current <stack>` | Just the active hash. |
| `af snapshot cat <stack> <hash> <route>` | Read raw bytes. |
| `af snapshot diff <stack> <hashA> <hashB>` | Structural diff between two snapshots. |
| `af list` / `af inspect <n>` / `af health` | Account-wide ops. |
| `af exec <METHOD> <path>` | Ad-hoc Cloudflare REST passthrough. |
| `af logs <worker>` | Wrangler tail wrapper. |

Mode A has no public CLI verbs — preview lifecycle is your host
application's concern.

## Packages

```
@astroflare/core              — interfaces (Site, Cache, Snapshots, Coordinator, Executor)
@astroflare/compiler          — .astro/.md/.mdx compiler
@astroflare/runtime           — render() + ABI + HMR client
@astroflare/preview           — preview-server + module graph + router
@astroflare/build             — buildSite + createSnapshotHandler (workers-runtime-safe)
@astroflare/build/node        — LocalSite + buildSite (Node-only)
@astroflare/content           — Zod-typed content collections
@astroflare/host-cloudflare   — createCoordinator, createPreviewHandler, R2Snapshots, etc.
@astroflare/site-workspace    — WorkspaceSite (adapter for @cloudflare/shell)
@astroflare/cli  / cli-lib    — `af` binary + library
@astroflare/test-utils        — in-memory implementations for framework tests
```

Only `@astroflare/host-cloudflare` and `@astroflare/site-workspace`
import Cloudflare-specific APIs.

## Status + roadmap

Pre-v0.1.0. The architectural North Star (framework, not app) is
realized at every layer. What remains:

- **Phase 26d** — five debugging-recipe e2e tests against
  credentialed CI.
- **Phase 28** — documentation site + reference-fixture promotion
  to `examples/`.
- **Phase 24b** — release readiness: npm publish, version pinning,
  24h soak, live cold-start measurement.
- **Phase 29** — Tier 1 polish (CSS modules, image format
  conversion, content loaders, etc.). Demand-driven post-release.

Active queue + history: [`docs/next-phases.md`](./docs/next-phases.md).
Per-phase plans + retros: [`docs/phases/`](./docs/phases/).

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm lint
```

E2e tests against real Cloudflare run on push to `main` + nightly
via `.github/workflows/e2e.yml`. Locally, source `.dev.vars` first:

```sh
set -a && . .dev.vars && set +a
pnpm vitest run --project e2e
```

## License

MIT.
