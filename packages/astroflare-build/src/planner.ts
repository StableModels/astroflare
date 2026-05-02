/**
 * Build planner — walks routes, decides what's prerenderable.
 *
 * Phase 7 minimum: every static route (no `[param]` segments) is
 * prerenderable. Dynamic routes need `getStaticPaths()` to enumerate the
 * concrete params at build time; that's still Tier 0 carryover from
 * Phase 3 (the Astro.* surface lists it but the runtime doesn't yet
 * implement it). Until then, dynamic routes are skipped at build.
 *
 * Phase 7+ wires the SSR side: routes the planner can't prerender become
 * SSR routes, packaged into a single WorkerCode module map for the runtime
 * Worker to execute.
 */

import type { Storage } from "@astroflare/core";
import { type Route, Router } from "@astroflare/preview";

export type RoutePlan =
	| { kind: "static"; route: Route; outputPath: string }
	| { kind: "skipped"; route: Route; reason: string };

export interface BuildPlan {
	routes: RoutePlan[];
	staticCount: number;
	skippedCount: number;
}

export async function plan(storage: Storage): Promise<BuildPlan> {
	const router = new Router();
	await router.discover(storage);

	const routes: RoutePlan[] = [];
	for (const route of router.routes) {
		if (!route.isStatic) {
			routes.push({
				kind: "skipped",
				route,
				reason: "dynamic route — getStaticPaths() deferred",
			});
			continue;
		}
		routes.push({
			kind: "static",
			route,
			outputPath: outputPathFor(route.filePath),
		});
	}

	return {
		routes,
		staticCount: routes.filter((r) => r.kind === "static").length,
		skippedCount: routes.filter((r) => r.kind === "skipped").length,
	};
}

/**
 * Map a workspace page path to the deploy artifact path (relative).
 *   `/src/pages/index.astro`        → `index.html`
 *   `/src/pages/about.astro`        → `about/index.html`
 *   `/src/pages/posts/hello.md`     → `posts/hello/index.html`
 *
 * Trailing-`index.html` form so `/about` and `/about/` both serve the
 * same file when the host walks the prefix.
 */
export function outputPathFor(filePath: string): string {
	const PAGES = "/src/pages/";
	if (!filePath.startsWith(PAGES)) {
		throw new Error(`outputPathFor: not a page path: ${filePath}`);
	}
	let rel = filePath.slice(PAGES.length);
	for (const ext of [".astro", ".md"]) {
		if (rel.endsWith(ext)) {
			rel = rel.slice(0, -ext.length);
			break;
		}
	}
	if (rel === "index") return "index.html";
	if (rel.endsWith("/index")) return `${rel.slice(0, -"/index".length)}/index.html`;
	return `${rel}/index.html`;
}
