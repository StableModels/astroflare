/**
 * File-based router for `src/pages/`.
 *
 * Tier 0 scope (Phase 3): static routes, `[name]` dynamic single-segment,
 * trailing-slash tolerance, static-before-dynamic precedence.
 * Tier 1 (Phase 6) adds `.md` files alongside `.astro`.
 * Phase 14 adds `.mdx` (full JSX-in-Markdown via `@mdx-js/mdx`).
 *
 * Deferred:
 *   - catchall `[...rest]`
 *   - rest-param patterns inside groups
 *   - finer-grained precedence (Astro has more nuance)
 */

import type { Site } from "@astroflare/core";

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
	/**
	 * Per-route props supplied by `getStaticPaths()` for the matched
	 * params, or `{}` for static routes / dynamic routes whose static
	 * paths haven't been resolved yet. The preview handler honours this
	 * by populating `Astro.props` from it. The router itself is pure
	 * pattern-matching and never invokes `getStaticPaths`; that runs
	 * later in the request pipeline (see
	 * `createPreviewHandler.resolveStaticPaths`).
	 */
	props: Record<string, unknown>;
}

const PAGES_PREFIX = "/src/pages";
const PAGE_EXTENSIONS: ReadonlyArray<{ ext: string; kind: RouteKind }> = [
	{ ext: ".astro", kind: "astro" },
	// Note ordering: `.mdx` is matched before `.md` so that, given a file
	// with both extensions in the same directory, the longer suffix wins.
	// `routeFromFilePath` walks this list in order and uses the first
	// match.
	{ ext: ".mdx", kind: "markdown" },
	{ ext: ".md", kind: "markdown" },
	// Server endpoints. Phase 11 adds `.ts` alongside `.js`; the endpoint
	// loader runs `.ts` source through `transformTS` (sucrase) before
	// bundling.
	{ ext: ".js", kind: "endpoint" },
	{ ext: ".ts", kind: "endpoint" },
];

export class Router {
	#routes: Route[] = [];

	get routes(): readonly Route[] {
		return this.#routes;
	}

	/** Walk the workspace and rebuild the route table. Idempotent. */
	async discover(site: Site): Promise<void> {
		const found: Route[] = [];
		const seen = new Set<string>();
		for (const { ext } of PAGE_EXTENSIONS) {
			for await (const filePath of site.glob(`${PAGES_PREFIX}/**/*${ext}`)) {
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
			return { route, params, props: {} };
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
