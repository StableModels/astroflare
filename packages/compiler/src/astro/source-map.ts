/**
 * Tiny v3 source-map generator. Phase 13 ships a "structural" map: one
 * mapping per generated line, all pointing back to line 1 column 0 of
 * the original source. Browser devtools and editors recognise the
 * `.astro` source as the origin file even if per-token positions
 * aren't yet precise.
 *
 * Per-token mappings (using each AST node's `range`) is a Phase 23
 * quality carryover — the emitter would need to track output offsets
 * on every emit, which is a substantial refactor of every `emit*()`
 * helper.
 */

export interface SourceMapV3 {
	version: 3;
	file?: string;
	sourceRoot?: string;
	sources: readonly string[];
	sourcesContent?: readonly (string | null)[];
	names: readonly string[];
	mappings: string;
}

/**
 * Produce a v3 source map mapping each line of `generated` back to
 * line 1, column 0 of `originalSource`.
 *
 * @param generated   The emitted JS module text.
 * @param originalSource The `.astro` source string.
 * @param filename    Original filename (e.g. `/src/pages/index.astro`).
 */
export function buildLineMap(
	generated: string,
	originalSource: string,
	filename: string,
): SourceMapV3 {
	const lineCount = countLines(generated);
	const mappings: string[] = [];
	for (let i = 0; i < lineCount; i++) {
		// Each line: a single segment with all-zero deltas (genCol=0,
		// sourceIdx=0, sourceLine=0, sourceCol=0). VLQ encoding of zero is
		// "A" — so the segment is "AAAA". Subsequent lines reset genCol.
		mappings.push(i === 0 ? "AAAA" : "AAAA");
	}
	return {
		version: 3,
		file: filenameToFile(filename),
		sources: [filename],
		sourcesContent: [originalSource],
		names: [],
		mappings: mappings.join(";"),
	};
}

function countLines(s: string): number {
	if (s.length === 0) return 0;
	let n = 1;
	for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
	// Trim trailing-newline so `"a\n".lines === 1`.
	if (s.charCodeAt(s.length - 1) === 10) n--;
	return n;
}

function filenameToFile(filename: string): string {
	// Strip leading directory; emit-time the `file` field is the
	// generated module's relative name. We don't ship .js artifacts to
	// disk in dev, so this is decorative — devtools shows it but doesn't
	// fetch.
	const base = filename.split("/").pop() ?? filename;
	return base.replace(/\.(astro|md)$/, ".js");
}

/**
 * Inline sourcemap as a base64 data URL — append to the generated
 * code as `//# sourceMappingURL=...` so devtools picks it up without
 * needing a separate `.map` file.
 */
export function inlineSourceMappingURL(map: SourceMapV3): string {
	const json = JSON.stringify(map);
	const b64 = base64encode(json);
	return `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${b64}\n`;
}

function base64encode(s: string): string {
	if (typeof Buffer !== "undefined") {
		return Buffer.from(s, "utf8").toString("base64");
	}
	// btoa works on Latin-1 only; encode via TextEncoder + chunk to
	// stay within the 0–255 byte range.
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}
