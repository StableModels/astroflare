/**
 * RSS feed generator (Phase 17).
 *
 * Pure function: takes feed metadata + an item list, returns RSS 2.0
 * XML as a string. No I/O, no external deps. The user wires it into
 * an endpoint:
 *
 *   import { generateRss } from "@astroflare/runtime";
 *   import { getCollection } from "@astroflare/runtime/content";
 *
 *   export async function GET(ctx: APIContext) {
 *     const posts = await getCollection("blog");
 *     return new Response(generateRss({
 *       title: "My Blog",
 *       description: "...",
 *       site: ctx.site!,
 *       items: posts.map((p) => ({
 *         title: p.data.title,
 *         link: `${ctx.site}blog/${p.slug}`,
 *         pubDate: p.data.date,
 *       })),
 *     }), { headers: { "content-type": "application/rss+xml" } });
 *   }
 *
 * RSS 2.0 spec compliance is "close enough for feed readers": title,
 * link, description on the channel; per-item title/link/description/
 * pubDate/guid. Atom equivalents (auto-generated) and custom extensions
 * land if they're requested.
 */

export interface RssFeedItem {
	title: string;
	/** Absolute URL to the canonical post page. */
	link: string;
	description?: string;
	/** RFC-822 string or `Date` (we format Dates ourselves). */
	pubDate?: string | Date;
	/** Globally-unique id. Defaults to `link`. */
	guid?: string;
	/** Optional categories — emitted as `<category>` per item. */
	categories?: readonly string[];
}

export interface RssFeedInput {
	title: string;
	description: string;
	/** Absolute origin (with trailing slash optional). */
	site: string;
	/** Feed-level language — `en-us`, `de-de`, etc. */
	language?: string;
	/** Path on `site` that serves the feed itself. Defaults to `/rss.xml`. */
	feedPath?: string;
	items: readonly RssFeedItem[];
}

/** Returns RSS 2.0 XML. */
export function generateRss(input: RssFeedInput): string {
	const site = stripTrailingSlash(input.site);
	const feedUrl = `${site}${input.feedPath ?? "/rss.xml"}`;

	const channel: string[] = [];
	channel.push(`<title>${escapeXml(input.title)}</title>`);
	channel.push(`<link>${escapeXml(`${site}/`)}</link>`);
	channel.push(`<description>${escapeXml(input.description)}</description>`);
	if (input.language) {
		channel.push(`<language>${escapeXml(input.language)}</language>`);
	}
	channel.push(`<atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`);

	for (const it of input.items) {
		channel.push("<item>");
		channel.push(`<title>${escapeXml(it.title)}</title>`);
		channel.push(`<link>${escapeXml(it.link)}</link>`);
		const guid = it.guid ?? it.link;
		channel.push(`<guid isPermaLink="${it.guid ? "false" : "true"}">${escapeXml(guid)}</guid>`);
		if (it.description) {
			channel.push(`<description>${escapeXml(it.description)}</description>`);
		}
		if (it.pubDate !== undefined) {
			channel.push(`<pubDate>${escapeXml(formatRssDate(it.pubDate))}</pubDate>`);
		}
		if (it.categories) {
			for (const c of it.categories) {
				channel.push(`<category>${escapeXml(c)}</category>`);
			}
		}
		channel.push("</item>");
	}

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
		"<channel>",
		channel.join(""),
		"</channel>",
		"</rss>",
	].join("");
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

/** RSS 2.0 wants RFC-822 date strings. */
export function formatRssDate(d: string | Date): string {
	if (typeof d === "string") return d;
	// `toUTCString()` happens to be RFC-822 compatible.
	return d.toUTCString();
}
