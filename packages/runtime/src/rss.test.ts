import { describe, expect, it } from "vitest";
import { formatRssDate, generateRss } from "./rss.js";

describe("generateRss", () => {
	it("emits a well-formed RSS 2.0 channel with required fields", () => {
		const xml = generateRss({
			title: "My Blog",
			description: "Posts",
			site: "https://app.example/",
			language: "en-us",
			items: [],
		});
		expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
		expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
		expect(xml).toContain("<channel>");
		expect(xml).toContain("<title>My Blog</title>");
		expect(xml).toContain("<description>Posts</description>");
		expect(xml).toContain("<link>https://app.example/</link>");
		expect(xml).toContain("<language>en-us</language>");
		expect(xml).toContain(
			'<atom:link href="https://app.example/rss.xml" rel="self" type="application/rss+xml" />',
		);
		expect(xml).toContain("</channel>");
		expect(xml).toContain("</rss>");
	});

	it("emits item entries with link/guid/description/pubDate/categories", () => {
		const xml = generateRss({
			title: "Blog",
			description: "Posts",
			site: "https://app.example",
			items: [
				{
					title: "Hello",
					link: "https://app.example/posts/hello",
					description: "First post",
					pubDate: new Date("2026-01-15T08:00:00Z"),
					categories: ["news", "intro"],
				},
			],
		});
		expect(xml).toContain("<item>");
		expect(xml).toContain("<title>Hello</title>");
		expect(xml).toContain("<link>https://app.example/posts/hello</link>");
		expect(xml).toContain('<guid isPermaLink="true">https://app.example/posts/hello</guid>');
		expect(xml).toContain("<description>First post</description>");
		// `toUTCString()` is RFC-822-compatible.
		expect(xml).toContain("<pubDate>Thu, 15 Jan 2026 08:00:00 GMT</pubDate>");
		expect(xml).toContain("<category>news</category>");
		expect(xml).toContain("<category>intro</category>");
		expect(xml).toContain("</item>");
	});

	it("marks guid as non-permalink when an explicit guid is provided", () => {
		const xml = generateRss({
			title: "Blog",
			description: "x",
			site: "https://app.example",
			items: [{ title: "T", link: "https://app.example/x", guid: "tag:custom-id-1" }],
		});
		expect(xml).toContain('<guid isPermaLink="false">tag:custom-id-1</guid>');
	});

	it("escapes XML-significant characters in title/description/link", () => {
		const xml = generateRss({
			title: 'A & "B" <C>',
			description: "x>y&z",
			site: "https://app.example",
			items: [{ title: "1 < 2", link: "https://app.example/?a=1&b=2" }],
		});
		expect(xml).toContain("<title>A &amp; &quot;B&quot; &lt;C&gt;</title>");
		expect(xml).toContain("<description>x&gt;y&amp;z</description>");
		expect(xml).toContain("<title>1 &lt; 2</title>");
		expect(xml).toContain("<link>https://app.example/?a=1&amp;b=2</link>");
	});

	it("respects feedPath override for atom:link self URL", () => {
		const xml = generateRss({
			title: "B",
			description: "d",
			site: "https://app.example/",
			feedPath: "/feed.xml",
			items: [],
		});
		expect(xml).toContain('href="https://app.example/feed.xml"');
	});

	it("formatRssDate passes string through unchanged", () => {
		expect(formatRssDate("Tue, 01 Jan 2026 00:00:00 GMT")).toBe("Tue, 01 Jan 2026 00:00:00 GMT");
	});
});
