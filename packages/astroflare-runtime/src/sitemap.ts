/**
 * Sitemap generator (Phase 17).
 *
 * Pure function returning a sitemaps.org-spec sitemap XML string.
 * Caller wires it into an endpoint:
 *
 *   export async function GET(ctx: APIContext) {
 *     return new Response(generateSitemap({
 *       site: ctx.site!,
 *       urls: ["/", "/about", "/blog/post-1", ...],
 *     }), { headers: { "content-type": "application/xml" } });
 *   }
 *
 * The framework can also build a sitemap automatically from the
 * static route table at deploy time (Phase 19 candidate). For now we
 * give users the helper and let them choose the route source.
 */

export interface SitemapUrlEntry {
	/** Absolute or root-relative URL. Relative paths are resolved against `site`. */
	loc: string;
	lastmod?: string | Date;
	changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
	/** 0.0–1.0. Out-of-range values are clamped. */
	priority?: number;
}

export interface SitemapInput {
	/** Absolute origin used to resolve root-relative `loc` values. */
	site: string;
	urls: ReadonlyArray<string | SitemapUrlEntry>;
}

/** Returns sitemaps.org-spec sitemap XML. */
export function generateSitemap(input: SitemapInput): string {
	const site = stripTrailingSlash(input.site);
	const out: string[] = [];
	out.push('<?xml version="1.0" encoding="UTF-8"?>');
	out.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');

	for (const raw of input.urls) {
		const entry: SitemapUrlEntry = typeof raw === "string" ? { loc: raw } : raw;
		const loc = entry.loc.startsWith("http") ? entry.loc : site + ensureLeadingSlash(entry.loc);
		out.push("<url>");
		out.push(`<loc>${escapeXml(loc)}</loc>`);
		if (entry.lastmod !== undefined) {
			out.push(`<lastmod>${escapeXml(formatSitemapDate(entry.lastmod))}</lastmod>`);
		}
		if (entry.changefreq !== undefined) {
			out.push(`<changefreq>${entry.changefreq}</changefreq>`);
		}
		if (entry.priority !== undefined) {
			out.push(`<priority>${clampPriority(entry.priority)}</priority>`);
		}
		out.push("</url>");
	}

	out.push("</urlset>");
	return out.join("");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function stripTrailingSlash(s: string): string {
	return s.endsWith("/") ? s.slice(0, -1) : s;
}

function ensureLeadingSlash(s: string): string {
	return s.startsWith("/") ? s : `/${s}`;
}

/** Sitemaps want W3C-format dates (`YYYY-MM-DD` or full ISO 8601). */
export function formatSitemapDate(d: string | Date): string {
	if (typeof d === "string") return d;
	return d.toISOString();
}

function clampPriority(p: number): string {
	if (p < 0) return "0.0";
	if (p > 1) return "1.0";
	// One decimal place — sitemaps spec recommends 0.0–1.0 increments of 0.1.
	return p.toFixed(1);
}
