/**
 * Tests for the built-in `<Image>` and `<Picture>` runtime components.
 * They consume `ImageMetadata` literals (compiler-resolved imports) or
 * bare URL strings, and emit valid `<img>` / `<picture>` HTML with
 * dimension attributes that prevent layout shift.
 */
import type { ImageMetadata } from "@astroflare/core";
import { describe, expect, it } from "vitest";
import { Image, Picture } from "./components.js";

describe("<Image>", () => {
	it("renders an <img> from ImageMetadata", async () => {
		const meta: ImageMetadata = {
			src: "/_aflare/asset/logo.png",
			width: 800,
			height: 200,
			format: "png",
		};
		const r = await Image({ src: meta, alt: "Logo" }, {});
		if (r instanceof Response) throw new Error("expected RawHtml");
		expect(r.html).toBe(
			'<img src="/_aflare/asset/logo.png" alt="Logo" width="800" height="200" />',
		);
	});

	it("accepts a bare URL string", async () => {
		const r = await Image({ src: "https://example.test/photo.jpg", alt: "remote" }, {});
		if (r instanceof Response) throw new Error("expected RawHtml");
		expect(r.html).toBe('<img src="https://example.test/photo.jpg" alt="remote" />');
	});

	it("explicit width/height override metadata", async () => {
		const meta: ImageMetadata = { src: "/x.png", width: 800, height: 200 };
		const r = await Image({ src: meta, alt: "x", width: 400, height: 100 }, {});
		if (r instanceof Response) throw new Error("expected RawHtml");
		expect(r.html).toContain('width="400"');
		expect(r.html).toContain('height="100"');
	});

	it("emits loading/decoding/class/id when supplied", async () => {
		const r = await Image(
			{
				src: "/x.png",
				alt: "x",
				loading: "lazy",
				decoding: "async",
				class: "rounded",
				id: "hero",
			},
			{},
		);
		if (r instanceof Response) throw new Error("expected RawHtml");
		expect(r.html).toContain('loading="lazy"');
		expect(r.html).toContain('decoding="async"');
		expect(r.html).toContain('class="rounded"');
		expect(r.html).toContain('id="hero"');
	});

	it("HTML-escapes attribute values", async () => {
		const r = await Image({ src: "/x.png?q=&a=<b>", alt: '"name"' }, {});
		if (r instanceof Response) throw new Error("expected RawHtml");
		expect(r.html).toContain("a=&lt;b&gt;");
		expect(r.html).toContain("&amp;");
		expect(r.html).toContain("&quot;name&quot;");
	});

	it("omits width/height attrs when metadata has none", async () => {
		const r = await Image({ src: { src: "/x.png" }, alt: "x" }, {});
		if (r instanceof Response) throw new Error("expected RawHtml");
		expect(r.html).not.toContain("width=");
		expect(r.html).not.toContain("height=");
	});
});

describe("<Picture>", () => {
	it("wraps an <img> in a <picture> element", async () => {
		const meta: ImageMetadata = { src: "/p.png", width: 100, height: 50 };
		const r = await Picture({ src: meta, alt: "p" }, {});
		if (r instanceof Response) throw new Error("expected RawHtml");
		expect(r.html).toBe('<picture><img src="/p.png" alt="p" width="100" height="50" /></picture>');
	});
});
