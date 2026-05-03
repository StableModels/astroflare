/**
 * i18n routing helpers (Phase 18).
 *
 * Two pure functions plus the `Astro.currentLocale` plumbing in
 * `internal.ts`'s `SharedRenderContext`. Both functions take an
 * explicit `I18nConfig` so they're trivial to test and free of
 * side effects.
 *
 *   - `deriveLocale(pathname, config)` — given a URL pathname and
 *     the project's i18n config, return the locale the request
 *     resolves to (the prefixed locale when present, otherwise the
 *     default locale). Used by the preview/deploy router to
 *     populate `Astro.currentLocale`.
 *   - `getRelativeLocaleUrl(locale, path, config)` — turn a
 *     locale + pathname into the URL the locale serves it from.
 *     The user-facing helper.
 *
 * Both stay framework-agnostic — no `URL`, no `Request`, no
 * `globalThis`. The router supplies a normalised pathname; the
 * link helper rebuilds whatever path the user authored.
 */

import type { I18nConfig } from "@astroflare/core";

/**
 * Resolve the current locale for a pathname using the project's
 * `I18nConfig`. Returns `config.defaultLocale` when no prefix
 * matches.
 *
 * Routing strategies:
 *   - `pathname-prefix-other` (default) — locales other than the
 *     default appear as `/<locale>/...`; the default locale serves
 *     `/...` with no prefix.
 *   - `prefix-default` — every locale, default included, appears
 *     as `/<locale>/...`. URLs without a prefix are still mapped
 *     to `defaultLocale` (callers may choose to redirect).
 */
export function deriveLocale(pathname: string, config: I18nConfig): string {
	const seg = firstSegment(pathname);
	if (seg && config.locales.includes(seg)) return seg;
	return config.defaultLocale;
}

/**
 * Build a URL path served by `locale` for the given workspace `path`.
 *
 *   getRelativeLocaleUrl("fr", "/about", config)  // → "/fr/about"
 *   getRelativeLocaleUrl("en", "/about", config)  // → "/about"   (default locale, prefix-other)
 *   getRelativeLocaleUrl("en", "/about", { routing: "prefix-default", ... }) // → "/en/about"
 *
 * `path` is the path *as if* there were no locale at all (typically
 * what the developer authors). A leading slash is normalised in;
 * the trailing slash is preserved.
 */
export function getRelativeLocaleUrl(locale: string, path: string, config: I18nConfig): string {
	const routing = config.routing ?? "pathname-prefix-other";
	const normalisedPath = path.startsWith("/") ? path : `/${path}`;
	const isDefault = locale === config.defaultLocale;
	if (isDefault && routing === "pathname-prefix-other") {
		return normalisedPath;
	}
	if (normalisedPath === "/") return `/${locale}`;
	return `/${locale}${normalisedPath}`;
}

function firstSegment(pathname: string): string {
	const trimmed = pathname.startsWith("/") ? pathname.slice(1) : pathname;
	const slash = trimmed.indexOf("/");
	return slash === -1 ? trimmed : trimmed.slice(0, slash);
}
