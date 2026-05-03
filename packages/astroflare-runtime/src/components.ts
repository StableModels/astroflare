/**
 * Built-in components — `<Image>` and `<Picture>`. Users author them as
 * normal Astro components:
 *
 *   ---
 *   import { Image } from "@astroflare/runtime/components";
 *   import logo from "../assets/logo.png";
 *   ---
 *   <Image src={logo} alt="Logo" />
 *
 * The compiler resolves the `import logo` to an `ImageMetadata` literal
 * (see `@astroflare/core#ImageMetadata`) at compile time. The runtime
 * renders that into a real `<img>` with width/height attributes so the
 * browser can reserve layout space.
 *
 * Phase 13 carve-outs:
 *   - No format conversion (AVIF/WebP), no DPR variants, no blurred
 *     placeholders. Those belong to the host's `ImageService`
 *     implementation; the framework just hands the metadata through.
 *   - `<Picture>` accepts a single source for now. Multi-source picture
 *     elements come when DPR variants land.
 */

import type { ImageMetadata } from "@astroflare/core";
import { $component, $render, type RawHtml } from "./internal.js";

/** Common props for `<Image>` and `<Picture>`. */
interface ImageProps {
	/** Either an `ImageMetadata` literal (the compiler-emitted shape) or a
	 *  plain string URL (escape hatch for remote images). */
	src: ImageMetadata | string;
	alt: string;
	/** Optional override — defaults to `metadata.width`. */
	width?: number | string;
	/** Optional override — defaults to `metadata.height`. */
	height?: number | string;
	/** `<img loading="lazy" />` etc. */
	loading?: "eager" | "lazy";
	/** `decoding` attribute: `"sync" | "async" | "auto"`. */
	decoding?: "sync" | "async" | "auto";
	/** Pass-through `class` attribute. */
	class?: string;
	/** Pass-through `id`. */
	id?: string;
}

/**
 * `<Image>` — emits an `<img>` element. Either consumes an
 * `ImageMetadata` literal (compiler-resolved import) or a bare URL.
 */
export const Image = $component(async (props: ImageProps): Promise<RawHtml> => {
	const r = resolve(props);
	const attrs = imgAttrs(r, props);
	return $render`<img${rawAttrs(attrs)} />`;
});

/**
 * `<Picture>` — emits a `<picture>` containing a single `<img>` source.
 * Phase 13's contract: identical output to `<Image>` plus the `<picture>`
 * wrapper, so callers can opt in early. Multi-source DPR/format variants
 * land alongside the asset pipeline's format-conversion work.
 */
export const Picture = $component(async (props: ImageProps): Promise<RawHtml> => {
	const r = resolve(props);
	const attrs = imgAttrs(r, props);
	return $render`<picture><img${rawAttrs(attrs)} /></picture>`;
});

interface Resolved {
	src: string;
	width?: number | string;
	height?: number | string;
	format?: string;
}

function resolve(props: ImageProps): Resolved {
	if (typeof props.src === "string") {
		return { src: props.src };
	}
	return {
		src: props.src.src,
		width: props.src.width,
		height: props.src.height,
		format: props.src.format,
	};
}

interface AttrPair {
	name: string;
	value: string;
}

function imgAttrs(r: Resolved, props: ImageProps): AttrPair[] {
	const out: AttrPair[] = [];
	out.push({ name: "src", value: r.src });
	out.push({ name: "alt", value: props.alt });
	const w = props.width ?? r.width;
	const h = props.height ?? r.height;
	if (w !== undefined) out.push({ name: "width", value: String(w) });
	if (h !== undefined) out.push({ name: "height", value: String(h) });
	if (props.loading) out.push({ name: "loading", value: props.loading });
	if (props.decoding) out.push({ name: "decoding", value: props.decoding });
	if (props.class) out.push({ name: "class", value: props.class });
	if (props.id) out.push({ name: "id", value: props.id });
	return out;
}

function rawAttrs(attrs: readonly AttrPair[]): RawHtml {
	let html = "";
	for (const { name, value } of attrs) {
		html += ` ${name}="${escapeAttr(value)}"`;
	}
	return { __astroRaw: true, html };
}

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
