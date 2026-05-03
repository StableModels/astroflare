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
 *   - astro/markdown pages under `/src/pages/`; dynamic routes need
 *     `getStaticPaths` (not yet supported, same as Node)
 *   - yields `SnapshotEntry` one at a time so callers can stream
 *     them straight into a `SnapshotSink.put`
 *   - route keys match `R2SnapshotSink`'s convention: leading /
 *     trailing slashes stripped, `/` → `index.html`
 *   - SHA-256 hex hash via Web Crypto, deterministic across runs
 *   - **closure-walking**: each page is rendered with its full
 *     transitive `.astro`/`.md`/`.mdx` import graph in the bundle, so
 *     pages that import a layout or a shared component render
 *     correctly.
 *
 * Differences from the Node version:
 *   - no `tmpDir` option (no filesystem)
 *   - the executor must supply a runtime modules map
 *     (`createWorkerdExecutor({ runtime })`) so the spawned isolate
 *     resolves `import { render } from "./runtime/index.js"`
 *   - no `node:crypto` / `node:fs` / `node:os` / `node:path` /
 *     `node:url` / `node:module` imports
 */

import type { Cache, Executor, Logger, RenderResult, Site, SnapshotEntry } from "@astroflare/core";
import { sha256Hex } from "@astroflare/core";
import { inlineBundle } from "@astroflare/preview/bundle";
import { ModuleGraph } from "@astroflare/preview/module-graph";
import {
	DEFAULT_RUNTIME_IMPORT,
	type RenderTaskInput,
	buildClosureRenderTask,
} from "./render-task.js";

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
	 * Optional compile cache. The closure walker memoises compiled
	 * `.astro`/`.md`/`.mdx` bytes here, keyed by source content +
	 * compiler config. When absent, every page recompiles every
	 * dependency from scratch — fine for one-shot CI builds, slow for
	 * repeated runs against the same source. Hosts that build often
	 * (Ember's per-snapshot agent loop, for example) should pass a
	 * `SqlCache` or equivalent.
	 */
	cache?: Cache;
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
 * Walk `Site.glob("/src/pages/**\/*.{astro,md,mdx}")`, compile + render
 * each page through the supplied executor, emit a `SnapshotEntry`. Each
 * page's full import closure (layouts, shared components, content
 * modules) is bundled together so cross-file imports resolve at render
 * time. Yields entries one-at-a-time so callers pipe to a
 * `SnapshotSink` without buffering the whole site in memory.
 *
 * Static-only. Dynamic routes (`[slug].astro`) need `getStaticPaths`
 * enumeration — not yet supported here.
 */
export async function* buildSite(opts: WorkersBuildSiteOptions): AsyncIterable<SnapshotEntry> {
	const enc = new TextEncoder();
	const cache = opts.cache ?? createNoopCache();
	const moduleGraph = new ModuleGraph(
		{ site: opts.site, cache, logger: opts.logger },
		{ runtimeImport: DEFAULT_RUNTIME_IMPORT },
	);

	const pagePatterns = [
		"/src/pages/**/*.astro",
		"/src/pages/**/*.md",
		"/src/pages/**/*.mdx",
	] as const;
	const seen = new Set<string>();
	const pages: string[] = [];
	for (const pattern of pagePatterns) {
		for await (const path of opts.site.glob(pattern)) {
			if (!path.startsWith("/src/pages/")) continue;
			if (seen.has(path)) continue;
			seen.add(path);
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
		const html = await compileAndRender(moduleGraph, opts.executor, sourcePath, route, opts.logger);
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

/**
 * `/src/pages/index.astro` → `/`; `/src/pages/about.astro` → `/about`;
 * `/src/pages/about.md` → `/about`; `/src/pages/blog/index.astro` → `/blog`.
 */
function pageRoute(sourcePath: string): string | null {
	const noPrefix = sourcePath.replace(/^\/src\/pages\//, "/");
	const noExt = noPrefix.replace(/\.(astro|mdx|md)$/, "");
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
	moduleGraph: ModuleGraph,
	executor: Executor,
	sourcePath: string,
	route: string,
	logger: Logger | undefined,
): Promise<string> {
	let closure: Awaited<ReturnType<ModuleGraph["closure"]>>;
	try {
		closure = await moduleGraph.closure(sourcePath);
	} catch (err) {
		logger?.event("buildSite.compile.failed", {
			path: sourcePath,
			message: (err as Error).message,
		});
		throw new Error(`buildSite: compile failed for ${sourcePath}: ${(err as Error).message}`);
	}

	const input: RenderTaskInput = {
		url: `http://stack.local${route}`,
		method: "GET",
		props: {},
		params: {},
	};

	let result: RenderResult;
	try {
		result = await executor.runCached<RenderResult>(
			closure.bundleKey,
			() => {
				const code = inlineBundle(closure.modules, DEFAULT_RUNTIME_IMPORT);
				return buildClosureRenderTask({ bundleCode: code });
			},
			input,
		);
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
