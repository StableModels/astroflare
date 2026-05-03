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
 *      `.astro` dep (each compile cache-checked via Storage.cacheRead/Write)
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
import { HMR_CLIENT_SOURCE } from "@astroflare/runtime";
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
	 * `file://` URL pointing at `astroflare-runtime/dist/index.js` so the
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
const PAGES_PREFIX = "/src/pages/";

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
			const stat = await opts.host.storage.stat(path);
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
			routesReady = router.discover(opts.host.storage);
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
				routesReady = router.discover(opts.host.storage);
				opts.host.logger.event("preview.routes.invalidated", {
					trigger: msg.trigger,
				});
			} else if (msg.type === "prune") {
				// File removal: if any pruned path lives under /src/pages/
				// the route table needs rebuilding (deleted page).
				if (msg.paths.some((p) => p.startsWith(PAGES_PREFIX))) {
					routesReady = router.discover(opts.host.storage);
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
						const sourceBytes = await opts.host.storage.read(match.route.filePath);
						const cacheId = await contentIdWithConfig(sourceBytes, {
							compiler: COMPILER_VERSION,
							kind: "endpoint",
						});
						const ctx: EndpointContext = {
							request: req,
							url,
							params: match.params,
							site: opts.config.site,
						};
						return runEndpoint({
							host: opts.host,
							filePath: match.route.filePath,
							cacheId,
							context: ctx,
						});
					}

					const closure = await moduleGraph.closure(match.route.filePath);
					const ctx: RenderContext = {
						props: {},
						params: match.params,
						request: req,
						url,
						site: opts.config.site,
						locals: mwLocals ?? {},
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
					const htmlWithHmr = injectHmrScript(result.html, HMR_CLIENT_SOURCE);
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

// Re-exports kept so downstream packages have a single import surface.
export { compileAstro, COMPILER_VERSION, contentIdWithConfig };
