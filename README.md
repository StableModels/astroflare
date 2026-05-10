# Astroflare

Cloudflare-native, Astro-compatible content framework.

Run an Astro-shaped project (`src/pages/`, `.astro` / `.md` / `.mdx`,
`astro.config.*`) on Cloudflare's isolate primitives — live
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

### Hard rule: Workers-runnable only

Every code path Astroflare exposes — compile, render, build,
runtime — must be runnable on a Cloudflare Worker. No exceptions,
no opt-ins for Node-class environments, no escape hatches that
ship paths the Worker can't execute. Concretely:

- **No runtime `WebAssembly.instantiate()`** of arbitrary bytes.
  The Worker embedder blocks it. Only `.wasm` modules statically
  declared in `wrangler.toml`'s `[wasm_modules]` may execute, and
  Astroflare doesn't ship any (so consumers don't have to wire
  them).
- **No `node:*` imports** in the runtime / preview / build
  pipelines that ship to a Worker. The Node-only build pipeline
  in `@astroflare/build/node` is for local CLI use; everything
  else (`@astroflare/build`, `@astroflare/host-cloudflare`,
  `@astroflare/runtime`, …) imports nothing from `node:*`.
- **No native bindings, no Vite, no esbuild-native.**
  `esbuild-wasm` is the one allowed bundler primitive.
- **No options that would let a host opt out of the rule.** When
  there's a choice between an incompatible-but-richer dependency
  and a compatible-but-thinner one, we ship only the compatible
  one. Example: Shiki's WASM (Oniguruma) regex engine is more
  accurate, but it can't run on a Worker, so Astroflare wires
  Shiki's pure-JS regex engine unconditionally — the WASM path
  isn't an option you can turn on, even via configuration.

If you find a code path that violates this, it's a bug. File it.

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

Deploy a fixture (Node — local CLI / CI):

```sh
af provision-stack myapp           # one-time: provision worker + R2
af deploy-static ./my-site --stack myapp   # compile + ship a snapshot
```

The framework compiles + renders locally, writes one
`SnapshotEntry` per route into R2 under
`<prefix><snapshotHash>/<route-key>`, then atomically flips
`<prefix>current`.

### In-Worker publish (no Node side-car)

`@astroflare/build` also exposes a workers-runtime-safe `buildSite`
so an agent / DO can pre-render snapshots from inside a Worker.
Pair it with `R2SnapshotSink` and `createWorkerdExecutor`:

```ts
import { buildSite } from "@astroflare/build";
import {
	R2SnapshotSink,
	createWorkerdExecutor,
} from "@astroflare/host-cloudflare";
import { runtimeModules } from "@astroflare/host-cloudflare/runtime-modules";

const sink = new R2SnapshotSink({ bucket: env.SITE_BUCKET, prefix: "sites/abc/" });
const executor = createWorkerdExecutor({
	loader: env.LOADER,
	runtime: runtimeModules,
});

const snapshotHash = await computeSnapshotHash(); // your content-addressed id
for await (const entry of buildSite({ site, executor })) {
	await sink.put(snapshotHash, entry);
}
await sink.commit(snapshotHash);
```

The `site` argument is any `Site` adapter — `WorkspaceSite` if you're
serving a `@cloudflare/shell` Workspace from a DO, `MemorySite` for
in-memory fixtures, or your own implementation. No `node:*` imports
in the build path.

Dynamic `[slug]` routes deploy too: `buildSite` invokes the route's
`getStaticPaths()` export through the same isolate it renders in,
and emits one `SnapshotEntry` per declared `{ params, props }` pair.
A `src/pages/posts/[slug].astro` whose `getStaticPaths` returns
`[{ params: { slug: "hello-world" }, props: { title: "Hello" } }]`
ships as `/posts/hello-world` with `Astro.props.title` populated —
identical semantics to what `createPreviewHandler` serves at
request time, so what you see in preview is what gets published.

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
	WorkspaceSite,
} from "@astroflare/host-cloudflare";
import { runtimeModules } from "@astroflare/host-cloudflare/runtime-modules";

interface Env { SITE_R2: R2Bucket; LOADER: WorkerLoader }

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
				// `nodejs_compat` is required — Astroflare's runtime
				// imports `node:async_hooks` to scope per-request state.
				// Add this to your worker's `wrangler.toml` AND pass it
				// through here so spawned compile/render isolates inherit
				// it.
				compatibilityFlags: ["nodejs_compat"],
				runtime: runtimeModules,
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

The `runtimeModules` import is the recommended way to wire the
runtime module map into `createWorkerdExecutor`. It's a sub-path
import that ships an inlined, bundler-agnostic `Record<string,
string>` — no esbuild `define`, no custom plugin, no
`__AFLARE_RUNTIME_MODULES__` global declaration. The legacy
global-substitution pattern still works for hosts that prefer
it but is no longer recommended.

Working reference: [`tests/e2e/fixtures/preview-host-ref/`](./tests/e2e/fixtures/preview-host-ref/).

### Markdown rendering

Astroflare ships markdown / MDX with Shiki **off by default**. Fenced
blocks render as plain `<pre><code class="language-…">…</code></pre>` —
content survives, no per-token coloring.

To opt in, pass the `markdown` option to `createPreviewHandler`
(Mode A) or `buildSite` (Mode B workers-runtime):

```ts
createPreviewHandler({
	site,
	coordinator,
	executor,
	cache,
	markdown: { shiki: true },  // highlight via Shiki's JS regex engine
});
```

`shiki` is a `boolean`. When enabled we always wire Shiki's pure-JS
regex engine (`createJavaScriptRegexEngine`); the WASM-backed
Oniguruma engine is intentionally not exposed — it can't run on a
Worker (see "Hard rule" below). The same option flows through to
`compileMarkdown` / `compileMdx` for hosts using the compilers
outside the preview pipeline.

## Starting a new project

`@astroflare/starter` ships the canonical minimum-viable scaffold —
layout component, index route, markdown route, dynamic `[slug]`
route via `getStaticPaths`, content collection with Zod schema, and
a public asset. Two consumption modes, both byte-identical:

**On disk (Node):**

```sh
af new ./my-site
```

**Programmatic (in-Worker — for hosts materializing fresh sites
inside a DO):**

```ts
import { getStarterFiles } from "@astroflare/starter";

for (const [path, bytes] of Object.entries(getStarterFiles())) {
	await workspaceSite.write(`/${path}`, bytes);
}
```

Recommended seed for any host embedding Astroflare in a multi-tenant
or agent workflow. The same map satisfies both modes so an agent
that materializes a site in-Worker can later be `git clone`d locally
and continue editing without drift.

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
| `af new <dir>` | Scaffold from `@astroflare/starter` (canonical seed). |
| `af init <dir>` | Scaffold a tiny hello-world project (legacy minimal scaffold). |
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
@astroflare/core                              — interfaces (Site, Cache, Snapshots, Coordinator, Executor)
@astroflare/compiler                          — .astro/.md/.mdx compiler
@astroflare/runtime                           — render() + ABI + HMR client
@astroflare/preview                           — preview-server + module graph + router
@astroflare/build                             — buildSite + createSnapshotHandler (workers-runtime-safe)
@astroflare/build/node                        — LocalSite + buildSite (Node-only)
@astroflare/content                           — Zod-typed content collections
@astroflare/host-cloudflare                   — the only Cloudflare-touching package: createCoordinator,
                                                 createPreviewHandler, R2Snapshots, WorkspaceSite, etc.
@astroflare/host-cloudflare/runtime-modules   — pre-inlined runtime modules map for createWorkerdExecutor
@astroflare/starter                           — canonical project scaffold (programmatic + on-disk)
@astroflare/starter/node                      — Node-only on-disk materialisation (writeStarterFiles)
@astroflare/cli  / cli-lib                    — `af` binary + library
@astroflare/test-utils                        — in-memory implementations for framework tests
```

`@astroflare/host-cloudflare` is the only package that imports
Cloudflare-specific APIs (`@cloudflare/shell`, R2 bindings, Worker
Loader bindings). Everything else in the framework is
Cloudflare-agnostic.

## Status + roadmap

Pre-v0.1.0. The architectural North Star (framework, not app) is
realized at every layer. The host-embedding surface (Mode A + Mode
B) is now end-to-end usable from inside another Cloudflare Worker:

- `@astroflare/build`'s workers-runtime `buildSite` lets hosts
  pre-render snapshots into R2 without a Node side-car.
- `@astroflare/host-cloudflare/runtime-modules` ships a
  bundler-agnostic inlined runtime map for `createWorkerdExecutor`.
- `@astroflare/starter` provides a canonical scaffold consumable
  programmatically (in-Worker materialisation) and via `af new`.

What remains:

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
