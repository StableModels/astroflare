/**
 * `buildSite` (workers-runtime) — the framework's build orchestrator
 * for hosts that compile + publish from inside a Cloudflare Worker.
 *
 * Mirrors the Node version (`build-site.ts`, exported as
 * `@astroflare/build/node`) but consumes capabilities (`Site`,
 * `Executor`) instead of reaching for the local filesystem and
 * Node's module loader. Designed to be paired with
 * `R2SnapshotSink` from `@astroflare/host-cloudflare` so an
 * agent / DO can pre-render snapshots to R2 without dialing out
 * to a Node side-car.
 *
 * Shape parity with the Node version:
 *   - astro-only (`/src/pages/**\/*.astro`); dynamic routes need
 *     `getStaticPaths` (not yet supported, same as Node)
 *   - yields `SnapshotEntry` one at a time so callers can stream
 *     them straight into a `SnapshotSink.put`
 *   - route keys match `R2SnapshotSink`'s convention: leading /
 *     trailing slashes stripped, `/` → `index.html`
 *   - SHA-256 hex hash via Web Crypto, deterministic across runs
 *
 * Differences from the Node version:
 *   - no `tmpDir` option (no filesystem)
 *   - the executor must supply a runtime modules map
 *     (`createWorkerdExecutor({ runtime })`) so the spawned isolate
 *     resolves `import { render } from "./runtime/index.js"`
 *   - no `node:crypto` / `node:fs` / `node:os` / `node:path` /
 *     `node:url` / `node:module` imports
 */

import { compileAstro } from "@astroflare/compiler/astro";
import {
	type Executor,
	type Logger,
	type RenderResult,
	type Site,
	type SnapshotEntry,
	sha256Hex,
} from "@astroflare/core";
import { DEFAULT_RUNTIME_IMPORT, type RenderTaskInput, buildRenderTask } from "./render-task.js";

export interface WorkersBuildSiteOptions {
	/** Read-only file capability — `WorkspaceSite`, `MemorySite`, etc. */
	site: Site;
	/**
	 * Spawns isolates to compile + render. In production this is
	 * `createWorkerdExecutor({ loader, runtime: runtimeModules })`;
	 * in tests `InProcessExecutor` works.
	 */
	executor: Executor;
	/**
	 * Optional route-prefix mounted under each built page. Defaults
	 * to `""` — pages under `/src/pages/index.astro` become route
	 * `/`. Mirrors the Node version's `prefix` option.
	 */
	prefix?: string;
	/** Optional structured logger; unused if absent. */
	logger?: Logger;
}

/**
 * Walk `Site.glob("/src/pages/**\/*.astro")`, compile + render each
 * page through the supplied executor, emit a `SnapshotEntry`. Yields
 * entries one-at-a-time so callers pipe to a `SnapshotSink` without
 * buffering the whole site in memory.
 *
 * Static-only. Dynamic routes (`[slug].astro`) need `getStaticPaths`
 * enumeration — not yet supported here.
 */
export async function* buildSite(opts: WorkersBuildSiteOptions): AsyncIterable<SnapshotEntry> {
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	const pagesGlob = "/src/pages/**/*.astro";
	const pages: string[] = [];
	for await (const path of opts.site.glob(pagesGlob)) {
		if (path.startsWith("/src/pages/") && path.endsWith(".astro")) {
			pages.push(path);
		}
	}
	// Stable order so deploy hashes are deterministic.
	pages.sort();

	for (const sourcePath of pages) {
		const localRoute = pageRoute(sourcePath);
		if (localRoute === null) {
			throw new Error(
				`buildSite: dynamic routes (${sourcePath}) need getStaticPaths to enumerate; not yet supported`,
			);
		}
		const route = prefixRoute(opts.prefix ?? "", localRoute);
		const sourceBytes = await opts.site.readFile(sourcePath);
		if (!sourceBytes) {
			throw new Error(`buildSite: missing source bytes for ${sourcePath}`);
		}
		const html = await compileAndRender(
			opts.executor,
			sourcePath,
			dec.decode(sourceBytes),
			route,
			opts.logger,
		);
		const bytes = enc.encode(html);
		const hash = await sha256Hex(bytes);
		yield {
			route,
			bytes,
			contentType: "text/html;charset=utf-8",
			hash,
		};
	}
}

/** `/src/pages/index.astro` → `/`; `/src/pages/about.astro` → `/about`. */
function pageRoute(sourcePath: string): string | null {
	const noPrefix = sourcePath.replace(/^\/src\/pages\//, "/");
	const noExt = noPrefix.replace(/\.astro$/, "");
	if (/\[[^\]]+\]/.test(noExt)) return null;
	if (noExt === "/index") return "/";
	if (noExt.endsWith("/index")) return noExt.slice(0, -"/index".length);
	return noExt;
}

function prefixRoute(prefix: string, route: string): string {
	if (!prefix) return route;
	const cleaned = prefix.replace(/^\/+|\/+$/g, "");
	if (route === "/") return `/${cleaned}/`;
	return `/${cleaned}${route}`;
}

async function compileAndRender(
	executor: Executor,
	sourcePath: string,
	source: string,
	route: string,
	logger: Logger | undefined,
): Promise<string> {
	let compiled: { code: string };
	try {
		compiled = await compileAstro(source, {
			filename: sourcePath,
			skipTsTransform: true,
			runtimeImport: DEFAULT_RUNTIME_IMPORT,
		});
	} catch (err) {
		logger?.event("buildSite.compile.failed", {
			path: sourcePath,
			message: (err as Error).message,
		});
		throw new Error(`buildSite: compile failed for ${sourcePath}: ${(err as Error).message}`);
	}

	const task = buildRenderTask({
		routeCode: compiled.code,
		runtimeImport: DEFAULT_RUNTIME_IMPORT,
	});
	const input: RenderTaskInput = {
		url: `http://stack.local${route}`,
		method: "GET",
		props: {},
		params: {},
	};

	let result: RenderResult;
	try {
		result = await executor.runOnce<RenderResult>(task, input);
	} catch (err) {
		logger?.event("buildSite.render.failed", {
			path: sourcePath,
			message: (err as Error).message,
		});
		throw new Error(`buildSite: render failed for ${sourcePath}: ${(err as Error).message}`);
	}

	if (result.kind === "html") return result.html;
	throw new Error(`buildSite: ${sourcePath} returned non-HTML render result (kind=${result.kind})`);
}
