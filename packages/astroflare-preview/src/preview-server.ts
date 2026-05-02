import { COMPILER_VERSION, compileAstro } from "@astroflare/compiler";
/**
 * Preview server — the dev-loop's request/response shape.
 *
 * Phase 3 minimum (per §7.3 of the brief): take a request, look up route,
 * compile via `Executor.runCached(contentHash, ...)`, render, return HTML.
 * No HMR, no module URL rewriting, no incremental graph — those are Phase 4+.
 *
 * Per-request flow:
 *   1. discover routes lazily on first request
 *   2. match URL pathname → route + params
 *   3. read source bytes from `host.storage`
 *   4. content-hash the source (mixed with the compiler version, per §9.4)
 *   5. `host.executor.runCached(hash, () => bundle(source), input)`:
 *        - factory builds a TaskBundle with the compiled `.astro` and a
 *          framework-side wrapper that calls `render()` for each invocation
 *        - input carries the per-request context (params, request, url)
 *        - returns the rendered HTML string
 *   6. wrap in a `Response` and return
 *
 * Phase 3 carve-outs (documented in the retro):
 *   - User imports inside `.astro` frontmatter (`import Layout from "./Foo.astro"`)
 *     are not yet resolved. Single-file pages only. URL rewriting lands in
 *     Phase 4.
 *   - The `Request` is passed by reference into the executor; that works for
 *     `InProcessExecutor` (no serialisation) but won't survive a real Worker
 *     Loader spawn. Phase 4+ handles request-shape marshalling.
 */
import {
	type AstroflareConfig,
	type Host,
	type RenderContext,
	type TaskBundle,
	contentIdWithConfig,
} from "@astroflare/core";
import { Router } from "./router.js";

export interface PreviewServerOptions {
	config: AstroflareConfig;
	host: Host;
	/**
	 * Module specifier the compiled `.astro` modules import the runtime from.
	 * Default `"@astroflare/runtime"` (which re-exports the internal ABI).
	 * Tests typically pass an absolute `file://` URL pointing at
	 * `astroflare-runtime/dist/index.js` so the InProcessExecutor's tmp-dir
	 * imports resolve.
	 */
	runtimeImport?: string;
}

export interface PreviewServer {
	fetch(req: Request): Promise<Response>;
}

const DEFAULT_RUNTIME_IMPORT = "@astroflare/runtime";

export function createPreviewServer(opts: PreviewServerOptions): PreviewServer {
	const router = new Router();
	const runtimeImport = opts.runtimeImport ?? DEFAULT_RUNTIME_IMPORT;
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

				const sourceBytes = await opts.host.storage.read(match.route.filePath);
				const source = new TextDecoder().decode(sourceBytes);

				// §9.4: content + transform-config descriptor → cache id.
				const cacheId = await contentIdWithConfig(source, {
					compiler: COMPILER_VERSION,
					runtimeImport,
				});

				const html = await opts.host.executor.runCached<string>(
					cacheId,
					() => buildRouteBundle(source, match.route.filePath, runtimeImport),
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
					cacheId,
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
 * Build the per-route TaskBundle. Two modules:
 *   - `route.js`: the compiled `.astro` (default-exporting an `$component`).
 *   - `main.js`: a tiny wrapper that imports the route + the runtime's `render()`
 *     and default-exports `(input) => render(Component, input)`.
 *
 * The bundle's `mainModule` is `main.js`; `Executor.runCached(id, factory, input)`
 * invokes its default export with the per-request input every call.
 */
function buildRouteBundle(source: string, filePath: string, runtimeImport: string): TaskBundle {
	const { code, errors } = compileAstro(source, { runtimeImport, filename: filePath });
	if (errors.length > 0) {
		const first = errors[0];
		if (first) {
			throw new Error(
				`compile error in ${filePath} at ${first.start.line}:${first.start.column}: ${first.message}`,
			);
		}
	}

	const wrapper = [
		'import Component from "./route.js";',
		`import { render } from ${JSON.stringify(runtimeImport)};`,
		"export default async (context) => render(Component, context);",
	].join("\n");

	return {
		mainModule: "main.js",
		modules: {
			"main.js": wrapper,
			"route.js": code,
		},
	};
}
