import { describe, expect, it } from "vitest";
import { buildSitemapFromRoutes, generateSitemap } from "./sitemap.js";

describe("generateSitemap", () => {
	it("emits a urlset with absolute loc URLs from string entries", () => {
		const xml = generateSitemap({
			site: "https://app.example/",
			urls: ["/", "/about", "/blog/post-1"],
		});
		expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
		expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
		expect(xml).toContain("<loc>https://app.example/</loc>");
		expect(xml).toContain("<loc>https://app.example/about</loc>");
		expect(xml).toContain("<loc>https://app.example/blog/post-1</loc>");
		expect(xml).toContain("</urlset>");
	});

	it("uses absolute URLs verbatim when given (no double-prefix)", () => {
		const xml = generateSitemap({
			site: "https://app.example",
			urls: ["https://other.example/page"],
		});
		expect(xml).toContain("<loc>https://other.example/page</loc>");
	});

	it("emits lastmod/changefreq/priority when provided", () => {
		const xml = generateSitemap({
			site: "https://app.example",
			urls: [
				{
					loc: "/about",
					lastmod: new Date("2026-02-01T00:00:00Z"),
					changefreq: "monthly",
					priority: 0.8,
				},
			],
		});
		expect(xml).toContain("<loc>https://app.example/about</loc>");
		expect(xml).toContain("<lastmod>2026-02-01T00:00:00.000Z</lastmod>");
		expect(xml).toContain("<changefreq>monthly</changefreq>");
		expect(xml).toContain("<priority>0.8</priority>");
	});

	it("clamps priority outside [0, 1]", () => {
		const xml = generateSitemap({
			site: "https://app.example",
			urls: [
				{ loc: "/a", priority: -1 },
				{ loc: "/b", priority: 5 },
			],
		});
		expect(xml).toContain("<priority>0.0</priority>");
		expect(xml).toContain("<priority>1.0</priority>");
	});

	it("normalises missing leading slash on relative loc", () => {
		const xml = generateSitemap({
			site: "https://app.example",
			urls: ["about"],
		});
		expect(xml).toContain("<loc>https://app.example/about</loc>");
	});

	it("escapes XML-significant characters in loc", () => {
		const xml = generateSitemap({
			site: "https://app.example",
			urls: ["/search?q=1&sort=desc"],
		});
		expect(xml).toContain("<loc>https://app.example/search?q=1&amp;sort=desc</loc>");
	});
});

describe("buildSitemapFromRoutes", () => {
	it("includes static .astro pages and collapses index", () => {
		const urls = buildSitemapFromRoutes([
			{ filePath: "/src/pages/index.astro", isStatic: true, kind: "astro" },
			{ filePath: "/src/pages/about.astro", isStatic: true, kind: "astro" },
			{ filePath: "/src/pages/blog/index.astro", isStatic: true, kind: "astro" },
		]);
		expect(urls.sort()).toEqual(["/", "/about", "/blog"]);
	});

	it("excludes dynamic routes", () => {
		const urls = buildSitemapFromRoutes([
			{ filePath: "/src/pages/index.astro", isStatic: true, kind: "astro" },
			{ filePath: "/src/pages/[slug].astro", isStatic: false, kind: "astro" },
		]);
		expect(urls).toEqual(["/"]);
	});

	it("excludes endpoints", () => {
		const urls = buildSitemapFromRoutes([
			{ filePath: "/src/pages/index.astro", isStatic: true, kind: "astro" },
			{ filePath: "/src/pages/api/echo.ts", isStatic: true, kind: "endpoint" },
		]);
		expect(urls).toEqual(["/"]);
	});

	it("respects excludePatterns", () => {
		const urls = buildSitemapFromRoutes(
			[
				{ filePath: "/src/pages/index.astro", isStatic: true, kind: "astro" },
				{ filePath: "/src/pages/admin/dashboard.astro", isStatic: true, kind: "astro" },
			],
			{ excludePatterns: [/^\/admin/] },
		);
		expect(urls).toEqual(["/"]);
	});

	it("does not collapse index when collapseIndex: false", () => {
		const urls = buildSitemapFromRoutes(
			[{ filePath: "/src/pages/index.astro", isStatic: true, kind: "astro" }],
			{ collapseIndex: false },
		);
		expect(urls).toEqual(["/index"]);
	});
});
