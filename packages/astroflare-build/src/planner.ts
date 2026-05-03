/**
 * Build planner — walks routes, decides what's prerenderable.
 *
 * Static routes (no `[param]` segments) prerender directly. Dynamic
 * routes (`/posts/[slug].astro`) prerender via `getStaticPaths()`: the
 * route module's exported async function returns an array of `{params,
 * props?}` entries, one prerendered HTML output per entry. Routes that
 * have no `getStaticPaths` (or return null) are skipped.
 *
 * Phase 7+ wires the SSR side: routes the planner can't prerender become
 * SSR routes, packaged into a single WorkerCode module map for the runtime
 * Worker to execute.
 */

import type { Host, Storage, TaskBundle } from "@astroflare/core";
import { ModuleGraph, type Route, Router, inlineBundle } from "@astroflare/preview";

export type RoutePlan =
	/** Static route — file path has no `[param]` segments. */
	| { kind: "static"; route: Route; outputPath: string }
	/** Dynamic route expanded via getStaticPaths. One plan per returned entry. */
	| {
			kind: "static-paths";
			route: Route;
			outputPath: string;
			params: Record<string, string>;
			props: Record<string, unknown>;
	  }
	/** Route that returns a redirect Response from frontmatter (Phase 10+). */
	| { kind: "redirect"; route: Route; outputPath: string }
	/** Route deferred from this build with a human-readable reason. */
	| { kind: "skipped"; route: Route; reason: string };

export interface BuildPlan {
	routes: RoutePlan[];
	staticCount: number;
	staticPathsCount: number;
	skippedCount: number;
}

export interface PlanOptions {
	host: Host;
	runtimeImport: string;
}

/**
 * Build the route plan over the workspace's pages. The host is used to
 * compile module closures and run the route module in `"paths"` mode for
 * `getStaticPaths` enumeration. Pure-static plans don't touch the host.
 */
export async function plan(opts: PlanOptions | Storage): Promise<BuildPlan> {
	// Backwards-compat: a bare `Storage` triggers the static-only fallback,
	// matching the pre-Phase-10 signature so existing tests keep working.
	const isFull = (v: unknown): v is PlanOptions =>
		typeof v === "object" && v !== null && "host" in (v as PlanOptions);
	const storage: Storage = isFull(opts) ? opts.host.storage : opts;

	const router = new Router();
	await router.discover(storage);

	const routes: RoutePlan[] = [];
	for (const route of router.routes) {
		if (route.isStatic) {
			routes.push({
				kind: "static",
				route,
				outputPath: outputPathFor(route.filePath),
			});
			continue;
		}
		// Dynamic route. We only know how to prerender `.astro` for now —
		// markdown getStaticPaths is a Phase 14 carryover.
		if (!isFull(opts) || route.kind !== "astro") {
			routes.push({
				kind: "skipped",
				route,
				reason: isFull(opts)
					? `dynamic route on ${route.kind} — getStaticPaths only supported for .astro`
					: "dynamic route — pass plan({host, runtimeImport}) to enumerate paths",
			});
			continue;
		}
		const expanded = await expandDynamicRoute(route, opts);
		if (expanded.length === 0) {
			routes.push({
				kind: "skipped",
				route,
				reason: "no getStaticPaths — dynamic route deferred to SSR",
			});
			continue;
		}
		routes.push(...expanded);
	}

	return {
		routes,
		staticCount: routes.filter((r) => r.kind === "static").length,
		staticPathsCount: routes.filter((r) => r.kind === "static-paths").length,
		skippedCount: routes.filter((r) => r.kind === "skipped").length,
	};
}

/**
 * For a dynamic route like `/src/pages/posts/[slug].astro`, compile its
 * module closure and invoke the bundle in `"paths"` mode to retrieve the
 * `getStaticPaths` array. Each entry produces one `static-paths` plan
 * with concrete params and a substituted output path
 * (`/posts/[slug].astro` + `{slug: "hello"}` → `posts/hello/index.html`).
 *
 * Returns an empty array if the route has no `getStaticPaths` export.
 */
async function expandDynamicRoute(route: Route, opts: PlanOptions): Promise<RoutePlan[]> {
	const moduleGraph = new ModuleGraph(opts.host, { runtimeImport: opts.runtimeImport });
	const closure = await moduleGraph.closure(route.filePath);
	const code = inlineBundle(closure.modules, opts.runtimeImport);

	const bundle: TaskBundle = { mainModule: "main.js", modules: { "main.js": code } };
	const result = await opts.host.executor.runOnce<readonly GetStaticPathsEntry[] | null>(bundle, {
		kind: "paths",
	});
	if (!result || !Array.isArray(result)) return [];

	const plans: RoutePlan[] = [];
	for (const entry of result) {
		const params = entry.params ?? {};
		const props = entry.props ?? {};
		// Astro coerces param values to strings — mirror that.
		const stringParams: Record<string, string> = {};
		for (const [k, v] of Object.entries(params)) stringParams[k] = String(v);
		plans.push({
			kind: "static-paths",
			route,
			outputPath: outputPathFor(route.filePath, stringParams),
			params: stringParams,
			props,
		});
	}
	return plans;
}

/**
 * Shape of a single `getStaticPaths()` array entry. JSON-serialisable so
 * it survives the executor's RPC boundary.
 */
export interface GetStaticPathsEntry {
	params: Record<string, string | number>;
	props?: Record<string, unknown>;
}

/**
 * Map a workspace page path to the deploy artifact path (relative). When
 * the path includes `[name]` segments and `params` is supplied, those
 * placeholders are replaced with the corresponding param values.
 *
 *   `/src/pages/index.astro`             → `index.html`
 *   `/src/pages/about.astro`             → `about/index.html`
 *   `/src/pages/posts/hello.md`          → `posts/hello/index.html`
 *   `/src/pages/posts/[slug].astro`      → `posts/${slug}/index.html`
 *
 * Trailing-`index.html` form so `/about` and `/about/` both serve the
 * same file when the host walks the prefix.
 */
export function outputPathFor(filePath: string, params: Record<string, string> = {}): string {
	const PAGES = "/src/pages/";
	if (!filePath.startsWith(PAGES)) {
		throw new Error(`outputPathFor: not a page path: ${filePath}`);
	}
	let rel = filePath.slice(PAGES.length);
	// `.mdx` checked before `.md` so the longer suffix wins.
	for (const ext of [".astro", ".mdx", ".md"]) {
		if (rel.endsWith(ext)) {
			rel = rel.slice(0, -ext.length);
			break;
		}
	}
	rel = rel.replace(/\[([A-Za-z_$][\w$]*)\]/g, (_, name) => {
		const value = params[name];
		if (value === undefined) {
			throw new Error(`outputPathFor: missing param '${name}' for ${filePath}`);
		}
		return encodeURIComponent(value);
	});
	if (rel === "index") return "index.html";
	if (rel.endsWith("/index")) return `${rel.slice(0, -"/index".length)}/index.html`;
	return `${rel}/index.html`;
}
