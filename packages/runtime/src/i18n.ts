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

/**
 * Astro-shaped alias for `deriveLocale`. Astro's i18n API exposes
 * `getLocaleByPath(pathname)`; we keep both names available so users
 * can copy patterns from Astro docs without an extra rename.
 */
export function getLocaleByPath(pathname: string, config: I18nConfig): string {
	return deriveLocale(pathname, config);
}

/**
 * Build an absolute URL by combining `site` with the locale-prefixed
 * path. `site` should be the canonical origin (with or without a
 * trailing slash); the trailing slash is normalised. Mirrors Astro's
 * `getAbsoluteLocaleUrl(locale, path, opts)`.
 */
export function getAbsoluteLocaleUrl(
	locale: string,
	path: string,
	config: I18nConfig,
	site: string,
): string {
	const rel = getRelativeLocaleUrl(locale, path, config);
	const stripped = site.endsWith("/") ? site.slice(0, -1) : site;
	return `${stripped}${rel}`;
}

/**
 * Parse an `Accept-Language` header into a preference-ordered list
 * of locales the project supports. Quality values (`q=`) drive the
 * ordering; ties keep the document order. Wildcards (`*`) and locales
 * outside `config.locales` are filtered out.
 *
 * Returns the list with most-preferred first. The first element is
 * also surfaced as `Astro.preferredLocale`; the full list is
 * `Astro.preferredLocaleList`.
 */
export function parsePreferredLocales(
	acceptLanguage: string | null | undefined,
	config: I18nConfig,
): readonly string[] {
	if (!acceptLanguage) return [];
	const items: { locale: string; q: number; order: number }[] = [];
	let order = 0;
	for (const part of acceptLanguage.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const [tagPart, ...rest] = trimmed.split(";").map((s) => s.trim());
		if (!tagPart || tagPart === "*") continue;
		// Match either the exact locale or the language-only prefix.
		// `en-US` should match a project locale of `en` if `en-US`
		// isn't supported.
		const candidate = config.locales.includes(tagPart)
			? tagPart
			: matchLanguagePrefix(tagPart, config.locales);
		if (!candidate) continue;
		let q = 1;
		for (const param of rest) {
			const m = /^q=([0-9.]+)$/.exec(param);
			if (m) q = Number.parseFloat(m[1] ?? "1");
		}
		items.push({ locale: candidate, q, order: order++ });
	}
	items.sort((a, b) => b.q - a.q || a.order - b.order);
	// Dedupe while preserving order.
	const seen = new Set<string>();
	const out: string[] = [];
	for (const it of items) {
		if (seen.has(it.locale)) continue;
		seen.add(it.locale);
		out.push(it.locale);
	}
	return out;
}

function matchLanguagePrefix(tag: string, locales: readonly string[]): string | null {
	const dash = tag.indexOf("-");
	if (dash < 0) return null;
	const prefix = tag.slice(0, dash);
	for (const l of locales) if (l === prefix) return l;
	return null;
}
