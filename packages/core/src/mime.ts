/**
 * `mimeForPath` — extension-based MIME type lookup used by the
 * preview handler's `public/` fallback and `buildSite`'s public-asset
 * walk so the bytes preview serves match the bytes the snapshot
 * commits. Tiny by design (~30 entries); hosts that need richer MIME
 * detection can call into a dedicated library — most assets in a
 * content site fit one of these buckets.
 *
 * Returns `application/octet-stream` for unknown extensions so callers
 * always get a non-empty content-type. The lookup is case-insensitive
 * on the extension; queries are normalized lower-case before lookup.
 *
 * Charset is appended to text-shaped types (`text/*`, JSON, JS, XML)
 * so browsers don't fall back to encoding heuristics on UTF-8 bytes.
 */

const MIME_TABLE: Readonly<Record<string, string>> = {
	// HTML / templating
	html: "text/html;charset=utf-8",
	htm: "text/html;charset=utf-8",
	// Stylesheets
	css: "text/css;charset=utf-8",
	// Scripts
	js: "text/javascript;charset=utf-8",
	mjs: "text/javascript;charset=utf-8",
	cjs: "text/javascript;charset=utf-8",
	// Data
	json: "application/json;charset=utf-8",
	jsonld: "application/ld+json;charset=utf-8",
	xml: "application/xml;charset=utf-8",
	rss: "application/rss+xml;charset=utf-8",
	atom: "application/atom+xml;charset=utf-8",
	txt: "text/plain;charset=utf-8",
	csv: "text/csv;charset=utf-8",
	md: "text/markdown;charset=utf-8",
	// Images
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	ico: "image/vnd.microsoft.icon",
	bmp: "image/bmp",
	tiff: "image/tiff",
	tif: "image/tiff",
	// Fonts
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	otf: "font/otf",
	eot: "application/vnd.ms-fontobject",
	// Audio
	mp3: "audio/mpeg",
	ogg: "audio/ogg",
	wav: "audio/wav",
	flac: "audio/flac",
	// Video
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	// Documents
	pdf: "application/pdf",
	zip: "application/zip",
	// Manifest-ish
	webmanifest: "application/manifest+json;charset=utf-8",
	map: "application/json;charset=utf-8",
};

const DEFAULT_MIME = "application/octet-stream";

export function mimeForPath(pathOrExt: string): string {
	// Accept either a full path (`/logo.png`) or a bare extension
	// (`png`, `.png`). Strip the leading dot if present and lowercase.
	let ext: string;
	if (pathOrExt.includes(".") || pathOrExt.startsWith(".")) {
		const dot = pathOrExt.lastIndexOf(".");
		if (dot === -1 || dot === pathOrExt.length - 1) return DEFAULT_MIME;
		ext = pathOrExt.slice(dot + 1).toLowerCase();
	} else {
		ext = pathOrExt.toLowerCase();
	}
	if (!ext) return DEFAULT_MIME;
	return MIME_TABLE[ext] ?? DEFAULT_MIME;
}
