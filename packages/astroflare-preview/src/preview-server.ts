/**
 * Preview server — the dev-loop's request/response shape.
 *
 * Phase 3 wired single-file routes; Phase 4 walks the import closure so a
 * route that imports other `.astro` modules renders correctly.
 *
 * Per-request flow:
 *   1. discover routes lazily on first request
 *   2. match URL pathname → route + params
 *   3. `ModuleGraph.closure(routeFilePath)` — compile route + every transitive
 *      `.astro` dep (each compile cache-checked via Storage.cacheRead/Write)
 *   4. build TaskBundle:
 *        - bundle path mirrors workspace path with `.astro → .js`
 *        - imports between modules rewritten `.astro → .js` to match
 *        - root wrapper imports the route + the runtime, default-exports
 *          `(input) => render(Component, input)`
 *   5. `host.executor.runCached(bundleKey, factory, input)` — bundleKey is
 *      the closure's aggregate cache id, so a dep change invalidates the
 *      cached isolate even when the route file itself didn't change
 *   6. response: HTML wrapped in `Response`, content-type text/html
 *
 * Phase 4 carve-outs (documented in the retro):
 *   - `Request` is still passed by reference into the executor; that works
 *     for `InProcessExecutor` (no serialisation) but won't survive a real
 *     Worker Loader spawn. Phase 5+ host work.
 *   - Reactive route discovery (Coordinator.onFileChanged → invalidate) is
 *     not wired yet. Routes are still cached forever after first request.
 *   - The `/_aflare/mod` endpoint (browser-fetchable compiled modules) is
 *     not wired here. Phase 4e or Phase 5 layer.
 */
import { COMPILER_VERSION, compileAstro } from "@astroflare/compiler";
import {
	type AstroflareConfig,
	type Host,
	type RenderContext,
	type TaskBundle,
	contentIdWithConfig,
} from "@astroflare/core";
import { inlineBundle } from "./bundle.js";
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
}

export interface PreviewServer {
	fetch(req: Request): Promise<Response>;
}

const DEFAULT_RUNTIME_IMPORT = "@astroflare/runtime";
const WRAPPER_NAME = "main.js";

export function createPreviewServer(opts: PreviewServerOptions): PreviewServer {
	const router = new Router();
	const runtimeImport = opts.runtimeImport ?? DEFAULT_RUNTIME_IMPORT;
	const moduleGraph = new ModuleGraph(opts.host, { runtimeImport });
	let routesReady: Promise<void> | null = null;

	async function ensureRoutes(): Promise<void> {
		if (!routesReady) {
			routesReady = router.discover(opts.host.storage);
		}
		await routesReady;
	}

	return {
		async fetch(req: Request): Promise<Response> {
			const start = opts.host.clock.now();
			try {
				await ensureRoutes();
				const url = new URL(req.url);
				const match = router.match(url.pathname);
				if (!match) {
					opts.host.logger.event("preview.notfound", { pathname: url.pathname });
					return new Response("Not found", {
						status: 404,
						headers: { "content-type": "text/plain;charset=utf-8" },
					});
				}

				const closure = await moduleGraph.closure(match.route.filePath);

				const html = await opts.host.executor.runCached<string>(
					closure.bundleKey,
					() => buildBundle(closure.modules, runtimeImport),
					{
						props: {},
						params: match.params,
						request: req,
						url,
						site: opts.config.site,
					} satisfies RenderContext,
				);

				opts.host.logger.event("preview.render", {
					pathname: url.pathname,
					filePath: match.route.filePath,
					bundleKey: closure.bundleKey,
					moduleCount: closure.modules.length,
					ms: opts.host.clock.now() - start,
				});

				return new Response(html, {
					status: 200,
					headers: { "content-type": "text/html;charset=utf-8" },
				});
			} catch (err) {
				opts.host.logger.event("preview.error", {
					url: req.url,
					message: (err as Error).message,
				});
				return new Response(`Preview error: ${(err as Error).message}`, {
					status: 500,
					headers: { "content-type": "text/plain;charset=utf-8" },
				});
			}
		},
	};
}

/**
 * Build the per-route TaskBundle from a compiled closure.
 *
 * The bundle is a single ESM file produced by `inlineBundle` (see `bundle.ts`).
 * Each compiled module is wrapped in an IIFE; `.astro` imports between them
 * are rewritten to references to those IIFEs' return values; the runtime is
 * the only outer `import`. This shape avoids the vite-node tmp-dir
 * intercept that bites multi-file bundles in the test pool — see Phase 2.5
 * retrospective and `bundle.ts` for the full reasoning.
 */
function buildBundle(modules: readonly ModuleInfo[], runtimeImport: string): TaskBundle {
	if (modules.length === 0) throw new Error("buildBundle: empty closure");
	const code = inlineBundle(modules, runtimeImport);
	return {
		mainModule: WRAPPER_NAME,
		modules: { [WRAPPER_NAME]: code },
	};
}

// Tiny re-export so callers don't have to dig — and we keep the symbols used
// (helps with the lint check and gives downstream packages a clean import).
export { compileAstro, COMPILER_VERSION, contentIdWithConfig };
