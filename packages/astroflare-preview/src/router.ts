/**
 * File-based router for `src/pages/`.
 *
 * Phase 3 scope (Tier 0 of the brief):
 *   - file extensions: `.astro` only (md/mdx is Phase 6, .ts/.js endpoints are Phase 8)
 *   - mapping: `src/pages/index.astro` → `/`,
 *              `src/pages/about.astro` → `/about`,
 *              `src/pages/posts/[slug].astro` → `/posts/<slug>`
 *   - dynamic single-segment params (`[name]`)
 *   - trailing-slash tolerance (request path with or without is matched)
 *
 * Deferred:
 *   - catchall `[...rest]`
 *   - non-`.astro` extensions
 *   - rest-param patterns inside groups (`[...path]`)
 *   - route precedence beyond "static before dynamic" (Astro has more nuance)
 */

import type { Storage } from "@astroflare/core";

export interface Route {
	/** Full file path within the workspace, e.g. `/src/pages/posts/[slug].astro`. */
	filePath: string;
	/** Compiled regex matching request pathnames. */
	pattern: RegExp;
	/** Names of dynamic parameters in declaration order. */
	paramNames: readonly string[];
	/**
	 * Whether the route has any dynamic segments. Static routes win match
	 * priority over dynamic ones — see `Router.match`.
	 */
	isStatic: boolean;
}

export interface RouteMatch {
	route: Route;
	params: Record<string, string>;
}

const PAGES_PREFIX = "/src/pages";
const PAGES_GLOB = "/src/pages/**/*.astro";

export class Router {
	#routes: Route[] = [];

	get routes(): readonly Route[] {
		return this.#routes;
	}

	/** Walk the workspace and rebuild the route table. Idempotent. */
	async discover(storage: Storage): Promise<void> {
		const found: Route[] = [];
		for await (const filePath of storage.glob(PAGES_GLOB)) {
			const route = routeFromFilePath(filePath);
			if (route) found.push(route);
		}
		// Static before dynamic so `/about.astro` wins over `/[slug].astro`.
		found.sort((a, b) => {
			if (a.isStatic !== b.isStatic) return a.isStatic ? -1 : 1;
			return a.filePath.localeCompare(b.filePath);
		});
		this.#routes = found;
	}

	match(pathname: string): RouteMatch | null {
		// Normalise: strip trailing slash unless it's the root.
		const normalised =
			pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
		for (const route of this.#routes) {
			const m = route.pattern.exec(normalised);
			if (!m) continue;
			const params: Record<string, string> = {};
			for (let i = 0; i < route.paramNames.length; i++) {
				const name = route.paramNames[i] as string;
				params[name] = decodeURIComponent(m[i + 1] as string);
			}
			return { route, params };
		}
		return null;
	}
}

// ---------------------------------------------------------------------------
// File path → route
// ---------------------------------------------------------------------------

const RE_PARAM_SEGMENT = /^\[([A-Za-z_$][\w$]*)\]$/;

export function routeFromFilePath(filePath: string): Route | null {
	if (!filePath.startsWith(`${PAGES_PREFIX}/`)) return null;
	const relative = filePath.slice(PAGES_PREFIX.length); // "/about.astro"
	if (!relative.endsWith(".astro")) return null;

	let withoutExt = relative.slice(0, -".astro".length); // "/about"

	// Index files: `/foo/index` → `/foo`, `/index` → `/` (sentinel below).
	if (withoutExt === "/index") {
		withoutExt = "/";
	} else if (withoutExt.endsWith("/index")) {
		withoutExt = withoutExt.slice(0, -"/index".length);
	}

	// Build pattern + paramNames by walking segments.
	const segments = withoutExt.split("/").filter(Boolean);
	const paramNames: string[] = [];
	let regexBody = "^";
	for (const seg of segments) {
		regexBody += "/";
		const paramMatch = RE_PARAM_SEGMENT.exec(seg);
		if (paramMatch) {
			paramNames.push(paramMatch[1] as string);
			regexBody += "([^/]+)";
		} else {
			regexBody += escapeRegex(seg);
		}
	}
	if (segments.length === 0) regexBody += "/";
	regexBody += "$";

	return {
		filePath,
		pattern: new RegExp(regexBody),
		paramNames,
		isStatic: paramNames.length === 0,
	};
}

const RE_REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s: string): string {
	return s.replace(RE_REGEX_SPECIAL, "\\$&");
}
