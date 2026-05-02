/**
 * File-based router for `src/pages/`.
 *
 * Tier 0 scope (Phase 3): static routes, `[name]` dynamic single-segment,
 * trailing-slash tolerance, static-before-dynamic precedence.
 * Tier 1 (Phase 6) adds `.md` files alongside `.astro`.
 *
 * Deferred:
 *   - catchall `[...rest]`
 *   - `.mdx` (Phase 6 stretch / future)
 *   - `.ts`/`.js` endpoints (Phase 8)
 *   - rest-param patterns inside groups
 *   - finer-grained precedence (Astro has more nuance)
 */

import type { Storage } from "@astroflare/core";

export type RouteKind = "astro" | "markdown" | "endpoint";

export interface Route {
	/** Full file path within the workspace, e.g. `/src/pages/posts/[slug].astro`. */
	filePath: string;
	/** Which compiler should handle this file. */
	kind: RouteKind;
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
const PAGE_EXTENSIONS: ReadonlyArray<{ ext: string; kind: RouteKind }> = [
	{ ext: ".astro", kind: "astro" },
	{ ext: ".md", kind: "markdown" },
	// Phase 8: server endpoints. JS-only until type-stripping lands;
	// `.ts` endpoints work in production via the host's pre-build TS→JS
	// pass, but in dev preview today they fail at module load. (See
	// Phase 6 retro for the type-stripping carryover.)
	{ ext: ".js", kind: "endpoint" },
];

export class Router {
	#routes: Route[] = [];

	get routes(): readonly Route[] {
		return this.#routes;
	}

	/** Walk the workspace and rebuild the route table. Idempotent. */
	async discover(storage: Storage): Promise<void> {
		const found: Route[] = [];
		const seen = new Set<string>();
		for (const { ext } of PAGE_EXTENSIONS) {
			for await (const filePath of storage.glob(`${PAGES_PREFIX}/**/*${ext}`)) {
				if (seen.has(filePath)) continue;
				seen.add(filePath);
				const route = routeFromFilePath(filePath);
				if (route) found.push(route);
			}
		}
		// Static before dynamic so `/about.astro` wins over `/[slug].astro`.
		// Within a tie, .astro wins over .md (matches Astro's precedence).
		found.sort((a, b) => {
			if (a.isStatic !== b.isStatic) return a.isStatic ? -1 : 1;
			if (a.kind !== b.kind) return a.kind === "astro" ? -1 : 1;
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
	const matchedExt = PAGE_EXTENSIONS.find(({ ext }) => relative.endsWith(ext));
	if (!matchedExt) return null;

	let withoutExt = relative.slice(0, -matchedExt.ext.length); // "/about"

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
		kind: matchedExt.kind,
		pattern: new RegExp(regexBody),
		paramNames,
		isStatic: paramNames.length === 0,
	};
}

const RE_REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s: string): string {
	return s.replace(RE_REGEX_SPECIAL, "\\$&");
}
