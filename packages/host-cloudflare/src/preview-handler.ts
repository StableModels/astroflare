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
 *   5. **For dynamic routes**, run the route module's `getStaticPaths`
 *      via `executor.runCached(bundleKey, …, { kind: "paths" })` and
 *      filter the URL params against the declared set. Unknown slugs
 *      404; matching entries supply the page's `Astro.props`. Result is
 *      memoised per bundleKey, so a layout edit invalidates the paths
 *      cache automatically.
 *   6. **`executor.runCached(bundleKey, …)`** — same closure → same
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

import {
	type RenderTaskInput,
	type StaticPathsResult,
	buildClosureRenderTask,
} from "@astroflare/build";
import { type ContentRuntimeModule, createContentRuntimeModule } from "@astroflare/content";
import type {
	Cache,
	Executor,
	HmrMessage,
	Logger,
	RenderResult,
	Site,
	Subscription,
} from "@astroflare/core";
import { mimeForPath } from "@astroflare/core";
import { inlineBundle } from "@astroflare/preview/bundle";
import { injectHmrScript } from "@astroflare/preview/inject-hmr";
import { type MarkdownOptions, ModuleGraph } from "@astroflare/preview/module-graph";
import { Router } from "@astroflare/preview/router";
import { buildHmrClientSource } from "@astroflare/runtime";
import type { AstroflareCoordinator } from "./coordinator.js";

/** Subpath of the workspace where Astroflare looks up routes. */
const PAGES_PREFIX = "/src/pages";

/** Subpath of the workspace where the public-asset fallback looks up files. */
const PUBLIC_PREFIX = "/public";

/** Subpath of the workspace where content collections live. */
const CONTENT_PREFIX = "/src/content";

/**
 * Module specifier the bundle imports the host-baked content snapshot
 * from. Relative form of `content.js` — resolves like the runtime
 * import. Only referenced when the project actually has
 * `/src/content/` entries.
 */
const CONTENT_IMPORT = "./content.js";

/**
 * Module specifier the compiled `.astro`/`.md`/`.mdx` modules import the
 * runtime from. The host's executor (`createWorkerdExecutor({ runtime })`
 * with `runtimeModules`) supplies the matching module map.
 */
const RUNTIME_IMPORT = "./runtime/index.js";

export interface HmrClientOptions {
	/**
	 * WebSocket path the injected HMR client opens. Default
	 * `/_aflare/hmr` — matches the path Astroflare's host helpers
	 * advertise. Hosts that mount the preview at a non-root prefix
	 * (e.g. `/s/<siteId>/...`) should set this to the prefixed path
	 * so the client connects against the per-site DO instead of
	 * landing at the host's origin.
	 */
	socketPath?: string;
}

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
	/**
	 * Markdown / MDX compilation options. Most commonly used to
	 * enable Shiki syntax highlighting — pass `markdown: { shiki:
	 * true }` to highlight fenced blocks via Shiki's pure-JS regex
	 * engine (the only Workers-compatible path). Default off so the
	 * happy path stays minimal.
	 */
	markdown?: MarkdownOptions;
	/**
	 * Inject the HMR client `<script type="module">…</script>` into
	 * rendered HTML responses (matching what the Node CLI preview
	 * server does). Default: `true`.
	 *
	 * Pass `false` for hosts that serve rendered pages outside an
	 * iframe context where HMR isn't useful (e.g. a static-snapshot
	 * preview). Pass an object to customise the WebSocket path the
	 * injected client opens — useful when the preview is mounted at
	 * a non-root prefix.
	 */
	hmr?: boolean | HmrClientOptions;
	/**
	 * Serve `/public/*` assets directly from the workspace as a
	 * fallback when no route matches. Mirrors standard Astro's
	 * convention — files under `/public/logo.png` become reachable at
	 * `/logo.png`. Default: `true`.
	 *
	 * `buildSite` (workers-runtime) emits matching `SnapshotEntry`s so
	 * the published snapshot agrees with what preview serves; see
	 * `WorkersBuildSiteOptions.publicAssets`.
	 */
	publicAssets?: boolean;
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
	/**
	 * `true` when the route file has dynamic `[param]` segments.
	 * Dynamic routes go through the `getStaticPaths` filter before
	 * rendering — a URL whose params don't match any declared entry
	 * 404s; matching entries contribute their `props` to the render.
	 * Static routes skip the filter and render with empty props.
	 */
	isDynamic: boolean;
}

export function createPreviewHandler(opts: CreatePreviewHandlerOptions): PreviewHandler {
	const cache = opts.cache ?? createNoopCache();
	const hmrEnabled = opts.hmr !== false;
	// Build the inline-client source once at handler-construction time —
	// the path doesn't change across requests, and the cost of
	// rebuilding per-request is wasted work.
	const hmrClientSource = hmrEnabled
		? buildHmrClientSource(typeof opts.hmr === "object" ? opts.hmr : {})
		: null;
	const publicAssetsEnabled = opts.publicAssets !== false;
	const moduleGraph = new ModuleGraph(
		{
			site: opts.site,
			cache,
			logger: opts.logger,
			coordinator: opts.coordinator,
		},
		{
			runtimeImport: RUNTIME_IMPORT,
			...(opts.markdown ? { markdown: opts.markdown } : {}),
		},
	);

	/**
	 * Per-bundle `getStaticPaths()` result cache. Keyed by bundleKey
	 * (which captures every module in the closure's compile state), so
	 * any source change that affects the route or its deps produces a
	 * fresh entry. Stale entries from previous bundleKeys leak but the
	 * map stays small under realistic project sizes; if it ever
	 * matters, prune on HMR `update`/`prune` events.
	 */
	const staticPathsCache = new Map<string, Promise<StaticPathsResult>>();

	// File-based router; only constructed if no `resolveRoute` override.
	const router = opts.resolveRoute ? null : new Router();
	let routesReady: Promise<void> | null = null;
	let routeInvalidationSub: Subscription | null = null;

	// Host-side content bake (feature: host-driven content collections).
	// Memoised across requests; busted when an HMR event touches
	// `/src/content/`, so an add/edit/delete of a `.md` is reflected on
	// the next render with no source edit to the route. `null` resolve
	// means the project has no `/src/content/` — zero-cost when unused.
	let contentReady: Promise<ContentRuntimeModule | null> | null = null;
	let contentInvalidationSub: Subscription | null = null;

	function ensureContent(): Promise<ContentRuntimeModule | null> {
		if (!contentReady) {
			contentReady = createContentRuntimeModule(opts.site, {
				...(opts.markdown ? { markdown: opts.markdown } : {}),
			});
			ensureContentInvalidation();
		}
		return contentReady;
	}

	function ensureContentInvalidation(): void {
		if (contentInvalidationSub) return;
		const touchesContent = (p: string): boolean => p.startsWith(`${CONTENT_PREFIX}/`);
		contentInvalidationSub = opts.coordinator.subscribe("hmr", (msg: HmrMessage) => {
			if (msg.type === "update") {
				if (msg.trigger && touchesContent(msg.trigger)) contentReady = null;
			} else if (msg.type === "prune") {
				if (msg.paths.some(touchesContent)) contentReady = null;
			}
		});
	}

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
			return { sourcePath, params: {}, kind, isDynamic: false };
		}
		await ensureRoutes();
		const match = router?.match(pathname);
		if (!match) return null;
		return {
			sourcePath: match.route.filePath,
			params: match.params,
			kind: match.route.kind,
			isDynamic: !match.route.isStatic,
		};
	}

	return {
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			const resolution = await resolve(url.pathname);
			if (!resolution) {
				if (publicAssetsEnabled) {
					const asset = await tryServePublicAsset(opts.site, url.pathname);
					if (asset) return asset;
				}
				return notFound(hmrClientSource);
			}
			// Endpoints (`.js` / `.ts` under `/src/pages/`) aren't part of
			// the Mode A surface this handler covers — hosts that want
			// them route those paths separately before reaching us.
			if (resolution.kind === "endpoint") {
				return notFound(hmrClientSource);
			}
			const content = await ensureContent();
			return renderRoute(
				opts,
				moduleGraph,
				staticPathsCache,
				resolution,
				req,
				hmrClientSource,
				content,
			);
		},
	};
}

/**
 * Serve a file under `/public/<path>` from the workspace as a static
 * asset, with an extension-derived content-type. Returns `null` when
 * the file is absent so the caller can fall through to a 404.
 *
 * Mirrors standard Astro's `public/` convention: a request for
 * `/logo.png` resolves to `/public/logo.png` in the workspace, and
 * the bytes are served verbatim with `image/png`. Hosts that don't
 * want this behaviour pass `publicAssets: false` to opt out.
 */
async function tryServePublicAsset(site: Site, requestPath: string): Promise<Response | null> {
	if (!requestPath.startsWith("/")) return null;
	// Reject path-traversal attempts up front — we're going to stat
	// `/public${requestPath}`, which would otherwise let `..` escape
	// the public directory.
	if (requestPath.includes("..")) return null;
	const assetPath = `${PUBLIC_PREFIX}${requestPath}`;
	const stat = await site.statFile(assetPath);
	if (!stat) return null;
	const bytes = await site.readFile(assetPath);
	if (!bytes) return null;
	// Copy into a fresh ArrayBuffer to satisfy `BodyInit`.
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return new Response(copy.buffer, {
		status: 200,
		headers: {
			"content-type": mimeForPath(requestPath),
			etag: `"${stat.hash}"`,
			"cache-control": "public, max-age=0, must-revalidate",
		},
	});
}

/**
 * Run the route's `getStaticPaths()` once per bundleKey, memoising the
 * result. Returns `null` if the route module doesn't export
 * `getStaticPaths` — which is an error for dynamic routes (the caller
 * 404s) but expected for static ones (the caller never calls in).
 */
async function fetchStaticPaths(
	executor: Executor,
	cache: Map<string, Promise<StaticPathsResult>>,
	bundleKey: string,
	taskFactory: () => ReturnType<typeof buildClosureRenderTask>,
): Promise<StaticPathsResult> {
	const existing = cache.get(bundleKey);
	if (existing) return existing;
	const promise = executor
		.runCached<StaticPathsResult>(bundleKey, taskFactory, { kind: "paths" })
		.catch((err) => {
			// On failure, drop the cache entry so the next request retries
			// (e.g. user fixed a syntax error in the route file).
			cache.delete(bundleKey);
			throw err;
		});
	cache.set(bundleKey, promise);
	return promise;
}

function findMatchingPath(
	paths: StaticPathsResult,
	urlParams: Record<string, string>,
): { params: Record<string, string>; props: Record<string, unknown> } | null {
	if (!paths) return null;
	for (const entry of paths) {
		if (paramsMatch(entry.params, urlParams)) {
			return {
				params: { ...entry.params },
				props: entry.props ? { ...entry.props } : {},
			};
		}
	}
	return null;
}

function paramsMatch(declared: Record<string, string>, url: Record<string, string>): boolean {
	const declaredKeys = Object.keys(declared);
	if (declaredKeys.length !== Object.keys(url).length) return false;
	for (const k of declaredKeys) {
		// `getStaticPaths` may return non-string values (e.g. numeric IDs);
		// stringify before comparing since URL-extracted params are always
		// strings.
		if (String(declared[k]) !== url[k]) return false;
	}
	return true;
}

async function renderRoute(
	opts: CreatePreviewHandlerOptions,
	moduleGraph: ModuleGraph,
	staticPathsCache: Map<string, Promise<StaticPathsResult>>,
	resolution: RouteResolution,
	request: Request,
	hmrClientSource: string | null,
	content: ContentRuntimeModule | null,
): Promise<Response> {
	const { sourcePath, isDynamic } = resolution;
	let { params } = resolution;
	let props: Record<string, unknown> = {};

	// Verify the file still exists. `Router.discover` runs on the
	// previous tree, so a freshly-deleted page may still be in the
	// table for one request after the prune; statFile is the
	// authoritative check.
	const stat = await opts.site.statFile(sourcePath);
	if (!stat) return notFound(hmrClientSource);

	let closure: Awaited<ReturnType<ModuleGraph["closure"]>>;
	try {
		closure = await moduleGraph.closure(sourcePath);
	} catch (err) {
		opts.logger?.event("preview.compile.failed", {
			path: sourcePath,
			message: (err as Error).message,
		});
		return errorResponse(500, `compile failed: ${(err as Error).message}`, hmrClientSource);
	}

	// `taskFactory` is shared between the optional `getStaticPaths` call
	// and the render call below — both go through the same bundleKey'd
	// isolate, so the executor only ever spawns once per closure.
	const taskFactory = () => {
		const code = inlineBundle(
			closure.modules,
			RUNTIME_IMPORT,
			content ? CONTENT_IMPORT : undefined,
		);
		return buildClosureRenderTask({
			bundleCode: code,
			...(content ? { contentModuleSource: content.source } : {}),
		});
	};

	// Fold the content digest into the execution cache key so a
	// content add/edit/delete busts the isolate even though the
	// route's `.astro` closure (`closure.bundleKey`) is unchanged.
	// Lock-step with the workers `buildSite` path.
	const execKey = content ? `${closure.bundleKey}:c:${content.digest}` : closure.bundleKey;

	// Dynamic routes: call `getStaticPaths()` to validate the URL params
	// and pick up the entry's `props`. A URL whose params don't appear
	// in the declared set 404s; matching entries set both `params`
	// (canonicalised through `getStaticPaths`'s shape, in case a value
	// was numeric) and `props`.
	if (isDynamic) {
		let staticPaths: StaticPathsResult;
		try {
			staticPaths = await fetchStaticPaths(opts.executor, staticPathsCache, execKey, taskFactory);
		} catch (err) {
			opts.logger?.event("preview.static-paths.failed", {
				path: sourcePath,
				message: (err as Error).message,
			});
			return errorResponse(
				500,
				`getStaticPaths failed: ${(err as Error).message}`,
				hmrClientSource,
			);
		}
		if (staticPaths === null) {
			// Dynamic route file with no `getStaticPaths` export. SSR-style
			// pass-through dynamic routing is a Phase-N follow-up; for now
			// the URL doesn't resolve.
			opts.logger?.event("preview.static-paths.missing", { path: sourcePath });
			return notFound(hmrClientSource);
		}
		const matched = findMatchingPath(staticPaths, params);
		if (!matched) return notFound(hmrClientSource);
		params = matched.params;
		props = matched.props;
	}

	const url = new URL(request.url);
	const input: RenderTaskInput = {
		url: url.href,
		method: request.method,
		props,
		params,
	};

	let result: RenderResult;
	try {
		result = await opts.executor.runCached<RenderResult>(execKey, taskFactory, input);
	} catch (err) {
		opts.logger?.event("preview.render.failed", {
			path: sourcePath,
			message: (err as Error).message,
		});
		return errorResponse(500, `render failed: ${(err as Error).message}`, hmrClientSource);
	}

	if (result.kind === "response") {
		const headers = new Headers(result.headers);
		for (const cookie of result.cookies) headers.append("set-cookie", cookie);
		// Only inject HMR into HTML responses produced by user code
		// (e.g. `Astro.redirect` keeps redirecting; a JSON 200 stays
		// JSON). The Node preview server applies the same gate.
		const contentType = headers.get("content-type") ?? "";
		if (
			hmrClientSource &&
			result.body !== null &&
			result.status === 200 &&
			contentType.toLowerCase().startsWith("text/html")
		) {
			return new Response(injectHmrScript(result.body, hmrClientSource), {
				status: result.status,
				headers,
			});
		}
		return new Response(result.body, { status: result.status, headers });
	}
	const headers = new Headers({ "content-type": "text/html;charset=utf-8" });
	for (const cookie of result.cookies) headers.append("set-cookie", cookie);
	const html = hmrClientSource ? injectHmrScript(result.html, hmrClientSource) : result.html;
	return new Response(html, { status: 200, headers });
}

function notFound(hmrClientSource: string | null): Response {
	return errorResponse(404, "Not found", hmrClientSource);
}

/**
 * HTML envelope for error / not-found responses. Wraps the message in
 * a small `<!doctype>`-prefixed page that re-injects the HMR client
 * `<script>` so a stranded iframe (manual reload onto a broken page,
 * fresh navigation, host without compile pre-flight) still holds an
 * open WebSocket and recovers as soon as the next clean change ships.
 *
 * Skips injection only when the host opted out (`hmr: false`); the
 * minimal `text/html` body is kept either way so browsers render the
 * same message rather than a generic plain-text 404/500.
 */
function errorResponse(status: number, message: string, hmrClientSource: string | null): Response {
	const body = renderErrorEnvelope(status, message, hmrClientSource);
	return new Response(body, {
		status,
		headers: { "content-type": "text/html;charset=utf-8" },
	});
}

function renderErrorEnvelope(
	status: number,
	message: string,
	hmrClientSource: string | null,
): string {
	const escapedMessage = escapeHtml(message);
	const title = status === 404 ? "Not found" : "Astroflare error";
	const script = hmrClientSource ? `<script type="module">${hmrClientSource}</script>` : "";
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>${escapeHtml(title)}</title>
	</head>
	<body>
		<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;padding:16px;margin:0;color:#7f1d1d;background:#fef2f2">${escapedMessage}</pre>
		${script}
	</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
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
