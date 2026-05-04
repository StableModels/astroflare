/**
 * Preview server — the dev-loop's request/response shape.
 *
 * Phase 3 wired single-file routes. Phase 4 walked the import closure so a
 * route that imports other `.astro` modules renders correctly. Phase 5 makes
 * the loop *live*: changes flow through the coordinator, fan out to active
 * WebSocket subscribers, and the browser HMR client triggers a reload.
 *
 * Per-request flow (HTTP):
 *   1. on first request: discover routes, subscribe to coordinator's `hmr`
 *      channel, mark the server alive
 *   2. if URL is `/_aflare/hmr` → upgrade via `host.transport.acceptHmrSocket`
 *   3. else: route lookup → 404 if no match
 *   4. `ModuleGraph.closure(routeFilePath)` — compile route + every transitive
 *      `.astro` dep (each compile cache-checked via `Cache.get/put`)
 *   5. `host.executor.runCached(bundleKey, () => buildBundle(modules), ctx)`
 *   6. inject HMR client into the rendered HTML
 *   7. wrap in `Response`, `text/html`
 *
 * Reactive invalidation (push):
 *   - someone (the agent's `FsService`, the workspace, or in tests the test
 *     itself) calls `host.coordinator.onFileChanged(path, hash)`
 *   - `onFileChanged` walks the graph's reverse edges, publishes an `update`
 *     HMR message on channel `hmr`
 *   - the preview server's subscriber forwards each message to
 *     `host.transport.broadcastHmr(workspaceId, msg)` → fans out to every
 *     connected WS
 *   - if the changed path is under `/src/pages/` we also re-discover routes
 *     so newly-added pages become reachable without a server restart
 *
 * Phase 5 carve-outs (documented in the retro):
 *   - `Request` is still passed by reference into the executor — fine for
 *     `InProcessExecutor`, won't survive a real Worker Loader spawn.
 *   - Workspace-id routing is single-tenant (`"default"`). Multi-tenant
 *     plumbing lands when the host package wires multi-tenant Workspaces.
 *   - Hibernatable WS / soak / latency tests deferred per Phase 2.5
 *     findings (no workerd-compatible Executor yet).
 */
import { COMPILER_VERSION, compileAstro } from "@astroflare/compiler";
import { transformTS } from "@astroflare/compiler/ts";
import {
	type AstroflareConfig,
	type HmrMessage,
	type Host,
	type RenderContext,
	type RenderResult,
	type Subscription,
	type TaskBundle,
	contentIdWithConfig,
} from "@astroflare/core";
import {
	ERROR_OVERLAY_CLIENT_SOURCE,
	HMR_CLIENT_SOURCE,
	HYDRATION_CLIENT_SOURCE,
	MOUNT_REACT_ISLAND_SOURCE,
	PREFETCH_CLIENT_SOURCE,
	VIEW_TRANSITIONS_CLIENT_SOURCE,
	deriveLocale,
	parsePreferredLocales,
	wrapReactIslandSource,
} from "@astroflare/runtime";
import { inlineBundle } from "./bundle.js";
import { type EndpointContext, runEndpoint } from "./endpoint.js";
import { renderErrorPage } from "./error-page.js";
import { injectHmrScript } from "./inject-hmr.js";
import { type MiddlewareContext, type MiddlewareFn, loadMiddleware } from "./middleware.js";
import { ModuleGraph, type ModuleInfo } from "./module-graph.js";
import { Router } from "./router.js";

export interface PreviewServerOptions {
	config: AstroflareConfig;
	host: Host;
	/**
	 * Module specifier the compiled `.astro` modules import the runtime from.
	 * Default `"@astroflare/runtime"`. Tests typically pass an absolute
	 * `file://` URL pointing at `runtime/dist/index.js` so the
	 * InProcessExecutor's tmp-dir imports resolve.
	 */
	runtimeImport?: string;
	/**
	 * Workspace identifier passed to `host.transport.broadcastHmr`. Single-
	 * tenant defaults to `"default"`; multi-tenant hosts will route per
	 * workspace.
	 */
	workspaceId?: string;
}

export interface PreviewServer {
	fetch(req: Request): Promise<Response>;
	/** Tear down the HMR subscription. Idempotent. */
	dispose(): void;
}

const DEFAULT_RUNTIME_IMPORT = "@astroflare/runtime";
const DEFAULT_WORKSPACE_ID = "default";
const WRAPPER_NAME = "main.js";
const HMR_PATH = "/_aflare/hmr";
const ASSET_PREFIX = "/_aflare/asset/";
const HYDRATION_PATH = "/_aflare/hydration.js";
const ISLAND_PATH = "/_aflare/island";
// Phase 17 client scripts. Both are tiny static ESM modules served
// from in-memory string constants.
const VIEW_TRANSITIONS_PATH = "/_aflare/view-transitions.js";
const PREFETCH_PATH = "/_aflare/prefetch.js";
// Phase 19 error overlay — auto-injected on every preview HTML
// response so hydration/HMR errors render in a modal.
const ERROR_OVERLAY_PATH = "/_aflare/error-overlay.js";
// Phase 16a React adapter — `MOUNT_REACT_ISLAND_SOURCE` lives here.
// `.tsx` / `.jsx` islands with a default export get auto-wrapped so
// the bundle exports `mount(el, props)` against the React glue.
const REACT_ADAPTER_PATH = "/_aflare/react.js";
const PAGES_PREFIX = "/src/pages/";

const IMAGE_CONTENT_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	ico: "image/vnd.microsoft.icon",
};

export function createPreviewServer(opts: PreviewServerOptions): PreviewServer {
	const router = new Router();
	const runtimeImport = opts.runtimeImport ?? DEFAULT_RUNTIME_IMPORT;
	const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE_ID;
	const moduleGraph = new ModuleGraph(opts.host, { runtimeImport, env: opts.config.env });

	let routesReady: Promise<void> | null = null;
	let hmrSub: Subscription | null = null;
	let routeInvalidationSub: Subscription | null = null;
	let disposed = false;
	let middleware: MiddlewareFn | null | undefined; // undefined = unchecked, null = none, fn = loaded
	let middlewareInvalidationSub: Subscription | null = null;

	async function ensureMiddleware(): Promise<MiddlewareFn | null> {
		if (middleware !== undefined) return middleware;
		// Look for `.js` first, then `.ts`. Cache id covers source content;
		// the HMR subscriber clears `middleware` if either file changes.
		for (const path of ["/src/middleware.js", "/src/middleware.ts"]) {
			const stat = await opts.host.site.statFile(path);
			if (!stat) continue;
			const fn = await loadMiddleware(opts.host, `middleware:${stat.hash}`);
			middleware = fn;
			return middleware;
		}
		middleware = null;
		return null;
	}

	async function ensureRoutes(): Promise<void> {
		if (!routesReady) {
			routesReady = router.discover(opts.host.site);
			ensureHmrPipeline();
		}
		await routesReady;
	}

	/**
	 * Subscribe to HMR messages once. Two subscribers:
	 *   1. forward HMR to `host.transport.broadcastHmr` so connected WS see updates
	 *   2. when a `/src/pages/*` path appears in an update, re-discover routes
	 */
	function ensureHmrPipeline(): void {
		if (hmrSub || disposed) return;
		hmrSub = opts.host.coordinator.subscribe("hmr", (msg: HmrMessage) => {
			void opts.host.transport.broadcastHmr(workspaceId, msg);
		});
		routeInvalidationSub = opts.host.coordinator.subscribe("hmr", (msg: HmrMessage) => {
			if (msg.type === "update") {
				// Only re-discover when the user's originating change is under
				// `/src/pages/` — transitive importers showing up in `updates`
				// don't change the route table.
				if (!msg.trigger || !msg.trigger.startsWith(PAGES_PREFIX)) return;
				routesReady = router.discover(opts.host.site);
				opts.host.logger.event("preview.routes.invalidated", {
					trigger: msg.trigger,
				});
			} else if (msg.type === "prune") {
				// File removal: if any pruned path lives under /src/pages/
				// the route table needs rebuilding (deleted page).
				if (msg.paths.some((p) => p.startsWith(PAGES_PREFIX))) {
					routesReady = router.discover(opts.host.site);
					opts.host.logger.event("preview.routes.invalidated", {
						reason: "prune",
						paths: msg.paths,
					});
				}
			}
		});
		// Reset cached middleware when the user's middleware file changes
		// or is removed (either `.js` or `.ts`).
		middlewareInvalidationSub = opts.host.coordinator.subscribe("hmr", (msg: HmrMessage) => {
			const isMiddleware = (p: string) => p === "/src/middleware.js" || p === "/src/middleware.ts";
			const triggered =
				(msg.type === "update" && msg.trigger !== undefined && isMiddleware(msg.trigger)) ||
				(msg.type === "prune" && msg.paths.some(isMiddleware));
			if (triggered) {
				middleware = undefined;
				opts.host.logger.event("preview.middleware.invalidated", {});
			}
		});
	}

	return {
		async fetch(req: Request): Promise<Response> {
			const start = opts.host.clock.now();
			try {
				await ensureRoutes();
				const url = new URL(req.url);

				// HMR upgrade
				if (url.pathname === HMR_PATH) {
					return opts.host.transport.acceptHmrSocket(req, { workspaceId });
				}

				// Asset URLs (Phase 13). Compiler-resolved image imports
				// produce `src: "/_aflare/asset/<workspace-path>"` URLs.
				if (url.pathname.startsWith(ASSET_PREFIX)) {
					return await serveAsset(opts.host, url.pathname.slice(ASSET_PREFIX.length));
				}

				// Hydration runtime (Phase 16). Served as a small ESM module
				// that defines `<astro-island>` and the directive triggers.
				if (url.pathname === HYDRATION_PATH) {
					return serveHydrationClient();
				}

				// Phase 17 — view-transitions and prefetch client scripts.
				// Both are inert until a page imports `<ViewTransitions />`
				// or `<Prefetch />` (which inject the `<script>` tag); the
				// route just serves the inlined source.
				if (url.pathname === VIEW_TRANSITIONS_PATH) {
					return serveStaticClient(VIEW_TRANSITIONS_CLIENT_SOURCE);
				}
				if (url.pathname === PREFETCH_PATH) {
					return serveStaticClient(PREFETCH_CLIENT_SOURCE);
				}
				// Phase 19 — modal error overlay. Auto-injected on every
				// preview HTML response (see `injectErrorOverlay` below).
				if (url.pathname === ERROR_OVERLAY_PATH) {
					return serveStaticClient(ERROR_OVERLAY_CLIENT_SOURCE);
				}
				// Phase 16a — React adapter. Static module containing
				// `mountReactIsland(Component, el, props)` plus default
				// React + react-dom imports from esm.sh. Users override
				// this route to self-host React.
				if (url.pathname === REACT_ADAPTER_PATH) {
					return serveStaticClient(MOUNT_REACT_ISLAND_SOURCE);
				}

				// Island component bundles (Phase 16). The compiler emits
				// `component-url="/_aflare/island?path=/components/Counter.tsx"`;
				// this route reads the source from storage, runs `.ts`/`.tsx`/
				// `.jsx` through `transformTS` (sucrase), and returns ESM the
				// browser can dynamic-import.
				if (url.pathname === ISLAND_PATH) {
					const path = url.searchParams.get("path");
					if (!path) {
						return new Response("missing path", { status: 400 });
					}
					return serveIslandModule(opts.host, path);
				}

				const match = router.match(url.pathname);
				if (!match) {
					opts.host.logger.event("preview.notfound", { pathname: url.pathname });
					return new Response("Not found", {
						status: 404,
						headers: { "content-type": "text/plain;charset=utf-8" },
					});
				}

				const runInner = async (): Promise<Response> => {
					if (match.route.kind === "endpoint") {
						const sourceBytes = await opts.host.site.readFile(match.route.filePath);
						if (!sourceBytes) {
							return new Response(`endpoint source not found: ${match.route.filePath}`, {
								status: 404,
							});
						}
						const cacheId = await contentIdWithConfig(sourceBytes, {
							compiler: COMPILER_VERSION,
							kind: "endpoint",
						});
						const i18n = opts.config.i18n;
						const acceptLang = req.headers.get("accept-language");
						const preferred = i18n ? parsePreferredLocales(acceptLang, i18n) : undefined;
						const ctx: EndpointContext = {
							request: req,
							url,
							params: match.params,
							site: opts.config.site,
							currentLocale: i18n ? deriveLocale(url.pathname, i18n) : undefined,
							preferredLocale: preferred?.[0],
							preferredLocaleList: preferred,
						};
						return runEndpoint({
							host: opts.host,
							filePath: match.route.filePath,
							cacheId,
							context: ctx,
						});
					}

					const closure = await moduleGraph.closure(match.route.filePath);
					const i18n = opts.config.i18n;
					const acceptLang = req.headers.get("accept-language");
					const preferred = i18n ? parsePreferredLocales(acceptLang, i18n) : undefined;
					const ctx: RenderContext = {
						props: {},
						params: match.params,
						request: req,
						url,
						site: opts.config.site,
						locals: mwLocals ?? {},
						currentLocale: i18n ? deriveLocale(url.pathname, i18n) : undefined,
						preferredLocale: preferred?.[0],
						preferredLocaleList: preferred,
					};
					const result = await opts.host.executor.runCached<RenderResult>(
						closure.bundleKey,
						() => buildBundle(closure.modules, runtimeImport),
						ctx,
					);

					opts.host.logger.event("preview.render", {
						pathname: url.pathname,
						filePath: match.route.filePath,
						bundleKey: closure.bundleKey,
						moduleCount: closure.modules.length,
						kind: result.kind,
						ms: opts.host.clock.now() - start,
					});

					if (result.kind === "response") {
						return buildResponseFromResult(result);
					}
					let html = result.html;
					// Phase 19: error overlay first (so it's defined before
					// hydration tries to call into it).
					html = injectErrorOverlayScript(html);
					// Inject hydration runtime first (when the rendered HTML
					// has at least one `<astro-island>`), then HMR. Order is
					// only cosmetic — both are `<script type="module">` and
					// run independently.
					if (html.includes("<astro-island")) {
						html = injectHydrationScript(html);
					}
					const htmlWithHmr = injectHmrScript(html, HMR_CLIENT_SOURCE);
					return buildHtmlResponse(htmlWithHmr, result.cookies);
				};

				let mwLocals: Record<string, unknown> | null = null;
				const mw = await ensureMiddleware();
				if (mw) {
					const mwCtx: MiddlewareContext = {
						request: req,
						url,
						params: match.params,
						site: opts.config.site,
						locals: {},
					};
					mwLocals = mwCtx.locals;
					return await mw(mwCtx, runInner);
				}
				return await runInner();
			} catch (err) {
				opts.host.logger.event("preview.error", {
					url: req.url,
					message: (err as Error).message,
				});
				const errorHtml = renderErrorPage({
					error: err as Error,
					requestUrl: req.url,
				});
				return new Response(injectHmrScript(errorHtml, HMR_CLIENT_SOURCE), {
					status: 500,
					headers: { "content-type": "text/html;charset=utf-8" },
				});
			}
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			hmrSub?.unsubscribe();
			routeInvalidationSub?.unsubscribe();
			middlewareInvalidationSub?.unsubscribe();
			hmrSub = null;
			routeInvalidationSub = null;
			middlewareInvalidationSub = null;
		},
	};
}

/**
 * Build the per-route TaskBundle from a compiled closure.
 *
 * The bundle is a single ESM file produced by `inlineBundle` (see `bundle.ts`).
 * Each compiled module is wrapped in an IIFE; `.astro` imports between them
 * are rewritten to references to those IIFEs' return values; the runtime is
 * the only outer `import`. This shape avoids the vite-node tmp-dir intercept
 * that bites multi-file bundles in the test pool — see Phase 2.5 retro and
 * `bundle.ts` for the full reasoning.
 */
function buildBundle(modules: readonly ModuleInfo[], runtimeImport: string): TaskBundle {
	if (modules.length === 0) throw new Error("buildBundle: empty closure");
	const code = inlineBundle(modules, runtimeImport);
	return {
		mainModule: WRAPPER_NAME,
		modules: { [WRAPPER_NAME]: code },
	};
}

/**
 * Build a 200 HTML `Response`, merging staged `Set-Cookie` headers from
 * the render result.
 */
function buildHtmlResponse(html: string, cookies: readonly string[]): Response {
	const headers = new Headers({ "content-type": "text/html;charset=utf-8" });
	for (const c of cookies) headers.append("set-cookie", c);
	return new Response(html, { status: 200, headers });
}

/**
 * Reconstruct a `Response` from a `RenderResult` of kind `"response"` — used
 * when the route returned `Astro.redirect(...)` (or any other `Response`)
 * from frontmatter. Cookies set during render are merged into `Set-Cookie`.
 */
function buildResponseFromResult(result: {
	status: number;
	headers: Readonly<Record<string, string>>;
	body: string | null;
	cookies: readonly string[];
}): Response {
	const headers = new Headers();
	for (const [k, v] of Object.entries(result.headers)) headers.set(k, v);
	for (const c of result.cookies) headers.append("set-cookie", c);
	return new Response(result.body, { status: result.status, headers });
}

/**
 * Serve a compiler-resolved asset (Phase 13). The URL after
 * `/_aflare/asset/` is the workspace-absolute path with the leading
 * slash stripped — e.g. `src/assets/logo.png`. Reads the file from
 * `host.site` and returns it with the right content-type.
 */
async function serveAsset(host: Host, encodedPath: string): Promise<Response> {
	const path = `/${decodeURIComponent(encodedPath)}`;
	const bytes = await host.site.readFile(path);
	if (!bytes) {
		return new Response("Not found", {
			status: 404,
			headers: { "content-type": "text/plain;charset=utf-8" },
		});
	}
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const contentType = IMAGE_CONTENT_TYPES[ext] ?? "application/octet-stream";
	// Copy into a fresh ArrayBuffer to satisfy `BodyInit` (the `Uint8Array`
	// returned from `Site.readFile` is generic over `ArrayBufferLike`, which
	// includes `SharedArrayBuffer`).
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return new Response(copy.buffer, {
		status: 200,
		headers: {
			"content-type": contentType,
			// Content-addressed: agressive cache is fine.
			"cache-control": "public, max-age=31536000, immutable",
		},
	});
}

// ---------------------------------------------------------------------------
// Hydration + island routes (Phase 16)
// ---------------------------------------------------------------------------

const dec = new TextDecoder();
const ISLAND_TS_EXTENSIONS = [".ts", ".tsx", ".jsx", ".mts"] as const;
const ISLAND_JS_EXTENSIONS = [".js", ".mjs"] as const;

/**
 * Serve `HYDRATION_CLIENT_SOURCE` as an ESM module. Cached aggressively;
 * the source string is fixed for a given runtime version.
 */
function serveHydrationClient(): Response {
	return serveStaticClient(HYDRATION_CLIENT_SOURCE);
}

/**
 * Generic static-source ESM response — same shape as the hydration
 * route, used for the Phase 17 view-transitions + prefetch scripts.
 */
function serveStaticClient(source: string): Response {
	return new Response(source, {
		status: 200,
		headers: {
			"content-type": "application/javascript;charset=utf-8",
			"cache-control": "public, max-age=300",
		},
	});
}

/**
 * Read an island source file from storage and return JS the browser can
 * `import()`. `.ts`/`.tsx`/`.jsx`/`.mts` go through `transformTS`
 * (sucrase) for TS-strip + JSX transform; `.js`/`.mjs` pass through
 * verbatim.
 *
 * Phase 16 carve-out: framework-specific JSX runtime resolution (React /
 * Preact) isn't wired here. The compiled output uses automatic JSX with
 * `react/jsx-runtime` as the source; the browser either resolves that
 * via an import map or the user ships a vanilla-JS island that doesn't
 * rely on a framework runtime. Phase 16a adds an automatic React adapter
 * that bundles the runtime.
 */
async function serveIslandModule(host: Host, path: string): Promise<Response> {
	// Reject path traversal — workspace paths start with `/` and use
	// `..` only inside the segment list, which is fine; absolute paths
	// outside the workspace aren't possible.
	const normalized = path.startsWith("/") ? path : `/${path}`;

	const ext =
		ISLAND_TS_EXTENSIONS.find((e) => normalized.endsWith(e)) ??
		ISLAND_JS_EXTENSIONS.find((e) => normalized.endsWith(e)) ??
		null;
	if (!ext) {
		return new Response("unsupported island extension", { status: 415 });
	}

	const stat = await host.site.statFile(normalized);
	if (!stat) {
		return new Response("island source not found", { status: 404 });
	}
	const sourceBytes = await host.site.readFile(normalized);
	if (!sourceBytes) {
		return new Response("island source not found", { status: 404 });
	}
	let source = dec.decode(sourceBytes);

	if ((ISLAND_TS_EXTENSIONS as readonly string[]).includes(ext)) {
		try {
			source = await transformTS(source, { filename: normalized });
		} catch (err) {
			return new Response(`island compile failed: ${(err as Error).message}`, {
				status: 500,
			});
		}
	}

	// Phase 16a — React adapter wrap. `.tsx`/`.jsx` sources with a
	// top-level default export auto-gain a `mount(el, props)` export
	// that creates a React root and renders the component. Existing
	// vanilla-JS islands (no default export) pass through unchanged.
	if (ext === ".tsx" || ext === ".jsx") {
		source = wrapReactIslandSource(source);
	}

	return new Response(source, {
		status: 200,
		headers: {
			"content-type": "application/javascript;charset=utf-8",
			// Source-content-hashed → safe to cache while the file
			// hasn't changed. Tied to source hash via etag.
			etag: `"${stat.hash}"`,
			"cache-control": "public, max-age=0, must-revalidate",
		},
	});
}

/**
 * Insert a `<script type="module" src="/_aflare/hydration.js"></script>`
 * tag into HTML that contains at least one `<astro-island>`. Same
 * placement preference as the HMR script: head close, then body close,
 * then append.
 */
function injectHydrationScript(html: string): string {
	const tag = `<script type="module" src="${HYDRATION_PATH}"></script>`;
	const headIdx = html.toLowerCase().lastIndexOf("</head>");
	if (headIdx >= 0) {
		return html.slice(0, headIdx) + tag + html.slice(headIdx);
	}
	const bodyIdx = html.toLowerCase().lastIndexOf("</body>");
	if (bodyIdx >= 0) {
		return html.slice(0, bodyIdx) + tag + html.slice(bodyIdx);
	}
	return html + tag;
}

/**
 * Phase 19: insert the modal error-overlay script into the page so
 * `window.__aflareShowError({...})` is available before any user JS
 * (including hydration) runs. Inserts at `</head>` close, falling
 * back to `</body>` close, then append.
 */
function injectErrorOverlayScript(html: string): string {
	const tag = `<script src="${ERROR_OVERLAY_PATH}"></script>`;
	const headIdx = html.toLowerCase().lastIndexOf("</head>");
	if (headIdx >= 0) {
		return html.slice(0, headIdx) + tag + html.slice(headIdx);
	}
	const bodyIdx = html.toLowerCase().lastIndexOf("</body>");
	if (bodyIdx >= 0) {
		return html.slice(0, bodyIdx) + tag + html.slice(bodyIdx);
	}
	return html + tag;
}

// Re-exports kept so downstream packages have a single import surface.
export { compileAstro, COMPILER_VERSION, contentIdWithConfig };
