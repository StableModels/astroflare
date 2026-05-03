/**
 * `createPreviewHandler` — request handler factory for Mode A
 * (in-Worker compile + render) under the host-driven architecture
 * (Phase 26).
 *
 * The host's worker (or DO) calls this with a `Site` capability, a
 * coordinator, and an executor; gets back a `{ fetch }` object it
 * can compose with its own routing.
 *
 * ## Pipeline
 *
 *   1. **Discover routes** via the framework's `Router` (file-based,
 *      `.astro` / `.md` / `.mdx`, dynamic `[slug]` segments). Cached;
 *      invalidated when the coordinator's HMR pipeline flags a
 *      `/src/pages/*` change.
 *   2. **Match the URL** against the route table; 404 if no match.
 *   3. **Walk the import closure** (`ModuleGraph.closure`) so layouts,
 *      shared components, and content modules end up in the bundle
 *      alongside the route. Each compile is cache-checked through the
 *      supplied `Cache`; the resulting `bundleKey` is the aggregate
 *      `Executor.runCached` id.
 *   4. **Inline-bundle** the closure into a single ESM (one IIFE per
 *      module, runtime imports outer-scope) — the shape Phase 4 settled
 *      on to dodge vite-node's tmp-dir module resolution. Wrap with the
 *      JSON shim from `buildClosureRenderTask` so the executor's
 *      JSON-RPC boundary survives.
 *   5. **`executor.runCached(bundleKey, …)`** — same closure → same
 *      isolate. A layout edit changes every dependent route's
 *      `bundleKey`, which forces a fresh isolate; a no-op edit
 *      preserves the cache.
 *
 * Default route mapping: file-based via `Router`. Hosts that want
 * different mapping pass `resolveRoute` to short-circuit to a single
 * file (params come back empty in that case).
 *
 * The handler does **not** know about HMR upgrades, file writes,
 * or any `/_aflare/*` paths. Those are host concerns. If a host
 * wants to expose an HMR WebSocket, they call `acceptHmrSocket` on
 * the coordinator inside their own routing.
 */

import { type RenderTaskInput, buildClosureRenderTask } from "@astroflare/build";
import type {
	Cache,
	Executor,
	HmrMessage,
	Logger,
	RenderResult,
	Site,
	Subscription,
} from "@astroflare/core";
import { inlineBundle } from "@astroflare/preview/bundle";
import { ModuleGraph } from "@astroflare/preview/module-graph";
import { Router } from "@astroflare/preview/router";
import type { AstroflareCoordinator } from "./coordinator.js";

/** Subpath of the workspace where Astroflare looks up routes. */
const PAGES_PREFIX = "/src/pages";

/**
 * Module specifier the compiled `.astro`/`.md`/`.mdx` modules import the
 * runtime from. The host's executor (`createWorkerdExecutor({ runtime })`
 * with `runtimeModules`) supplies the matching module map.
 */
const RUNTIME_IMPORT = "./runtime/index.js";

export interface CreatePreviewHandlerOptions {
	site: Site;
	coordinator: AstroflareCoordinator;
	executor: Executor;
	cache?: Cache;
	/**
	 * Override the default file-based route resolution. Receives
	 * `pathname`, returns the workspace path of the source file to
	 * compile (no params), or `null` for "let the handler return 404."
	 *
	 * Default: file-based routing through `@astroflare/preview`'s
	 * `Router` — `.astro` / `.md` / `.mdx` files under
	 * `/src/pages/`, with `[slug]` dynamic segments. Layouts and
	 * shared components are picked up via import-closure walking, so
	 * hosts shouldn't normally need to override this.
	 */
	resolveRoute?: (pathname: string) => string | null;
	/** Optional structured logger; unused if absent. */
	logger?: Logger;
}

export interface PreviewHandler {
	fetch(req: Request): Promise<Response>;
}

interface RouteResolution {
	sourcePath: string;
	params: Record<string, string>;
	kind: "astro" | "markdown" | "endpoint";
}

export function createPreviewHandler(opts: CreatePreviewHandlerOptions): PreviewHandler {
	const cache = opts.cache ?? createNoopCache();
	const moduleGraph = new ModuleGraph(
		{
			site: opts.site,
			cache,
			logger: opts.logger,
			coordinator: opts.coordinator,
		},
		{ runtimeImport: RUNTIME_IMPORT },
	);

	// File-based router; only constructed if no `resolveRoute` override.
	const router = opts.resolveRoute ? null : new Router();
	let routesReady: Promise<void> | null = null;
	let routeInvalidationSub: Subscription | null = null;

	function ensureRoutes(): Promise<void> {
		if (!router) return Promise.resolve();
		if (!routesReady) {
			routesReady = router.discover(opts.site);
			ensureRouteInvalidation();
		}
		return routesReady;
	}

	function ensureRouteInvalidation(): void {
		if (!router || routeInvalidationSub) return;
		routeInvalidationSub = opts.coordinator.subscribe("hmr", (msg: HmrMessage) => {
			// Re-discover when a `/src/pages/*` change comes through. The
			// coordinator's `notifyChanged` walks reverse edges, so the
			// trigger is what the user actually touched.
			if (msg.type === "update") {
				if (!msg.trigger || !msg.trigger.startsWith(`${PAGES_PREFIX}/`)) return;
				routesReady = router.discover(opts.site);
			} else if (msg.type === "prune") {
				if (msg.paths.some((p) => p.startsWith(`${PAGES_PREFIX}/`))) {
					routesReady = router.discover(opts.site);
				}
			}
		});
	}

	async function resolve(pathname: string): Promise<RouteResolution | null> {
		if (opts.resolveRoute) {
			const sourcePath = opts.resolveRoute(pathname);
			if (!sourcePath) return null;
			const kind = sourcePath.endsWith(".md") || sourcePath.endsWith(".mdx") ? "markdown" : "astro";
			return { sourcePath, params: {}, kind };
		}
		await ensureRoutes();
		const match = router?.match(pathname);
		if (!match) return null;
		return {
			sourcePath: match.route.filePath,
			params: match.params,
			kind: match.route.kind,
		};
	}

	return {
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			const resolution = await resolve(url.pathname);
			if (!resolution) {
				return notFound();
			}
			// Endpoints (`.js` / `.ts` under `/src/pages/`) aren't part of
			// the Mode A surface this handler covers — hosts that want
			// them route those paths separately before reaching us.
			if (resolution.kind === "endpoint") {
				return notFound();
			}
			return renderRoute(opts, moduleGraph, resolution, req);
		},
	};
}

async function renderRoute(
	opts: CreatePreviewHandlerOptions,
	moduleGraph: ModuleGraph,
	resolution: RouteResolution,
	request: Request,
): Promise<Response> {
	const { sourcePath, params } = resolution;

	// Verify the file still exists. `Router.discover` runs on the
	// previous tree, so a freshly-deleted page may still be in the
	// table for one request after the prune; statFile is the
	// authoritative check.
	const stat = await opts.site.statFile(sourcePath);
	if (!stat) return notFound();

	let closure: Awaited<ReturnType<ModuleGraph["closure"]>>;
	try {
		closure = await moduleGraph.closure(sourcePath);
	} catch (err) {
		opts.logger?.event("preview.compile.failed", {
			path: sourcePath,
			message: (err as Error).message,
		});
		return new Response(`compile failed: ${(err as Error).message}`, {
			status: 500,
			headers: { "content-type": "text/plain;charset=utf-8" },
		});
	}

	const url = new URL(request.url);
	const input: RenderTaskInput = {
		url: url.href,
		method: request.method,
		props: {},
		params,
	};

	let result: RenderResult;
	try {
		result = await opts.executor.runCached<RenderResult>(
			closure.bundleKey,
			() => {
				const code = inlineBundle(closure.modules, RUNTIME_IMPORT);
				return buildClosureRenderTask({ bundleCode: code });
			},
			input,
		);
	} catch (err) {
		opts.logger?.event("preview.render.failed", {
			path: sourcePath,
			message: (err as Error).message,
		});
		return new Response(`render failed: ${(err as Error).message}`, {
			status: 500,
			headers: { "content-type": "text/plain;charset=utf-8" },
		});
	}

	if (result.kind === "response") {
		const headers = new Headers(result.headers);
		for (const cookie of result.cookies) headers.append("set-cookie", cookie);
		return new Response(result.body, { status: result.status, headers });
	}
	const headers = new Headers({ "content-type": "text/html;charset=utf-8" });
	for (const cookie of result.cookies) headers.append("set-cookie", cookie);
	return new Response(result.html, { status: 200, headers });
}

function notFound(): Response {
	return new Response("Not found", {
		status: 404,
		headers: { "content-type": "text/plain;charset=utf-8" },
	});
}

/**
 * In-memory no-op cache used when the host doesn't supply one. Compiles
 * still happen, just not memoised across requests.
 */
function createNoopCache(): Cache {
	return {
		async get(): Promise<Uint8Array | null> {
			return null;
		},
		async put(): Promise<void> {
			/* no-op */
		},
	};
}
