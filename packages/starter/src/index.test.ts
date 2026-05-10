/**
 * `@astroflare/starter` unit tests.
 *
 * Verifies:
 *   - `getStarterFiles()` returns a non-empty `Record<string, Uint8Array>`
 *   - the canonical file set is present (config, layout, index page,
 *     markdown route, dynamic route, content collection, public asset)
 *   - decoded contents match the on-disk template byte-for-byte
 *   - `getStarterFile(path)` returns null for unknown paths and the
 *     same bytes as the map for known ones
 *   - `starterFilePaths` is alphabetically sorted (stable iteration)
 *   - paths are POSIX-style with no leading slash (host-friendly)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getStarterFile, getStarterFiles, starterFilePaths } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(__dirname, "../template");

const CANONICAL_PATHS = [
	".gitignore",
	"README.md",
	"astro.config.ts",
	"package.json",
	"public/favicon.svg",
	"src/content/blog/hello-world.md",
	"src/content/config.ts",
	"src/layouts/Base.astro",
	"src/pages/about.md",
	"src/pages/index.astro",
	"src/pages/posts/[slug].astro",
];

describe("@astroflare/starter", () => {
	it("ships every canonical scaffold file", () => {
		expect([...starterFilePaths].sort()).toEqual([...CANONICAL_PATHS].sort());
	});

	it("paths are POSIX-style with no leading slash", () => {
		for (const path of starterFilePaths) {
			expect(path).not.toMatch(/^\//);
			expect(path).not.toMatch(/\\/); // no Windows separators
		}
	});

	it("starterFilePaths is alphabetically sorted", () => {
		const sorted = [...starterFilePaths].sort();
		expect([...starterFilePaths]).toEqual(sorted);
	});

	it("getStarterFiles decodes to byte-identical template contents", () => {
		const files = getStarterFiles();
		for (const path of starterFilePaths) {
			const onDisk = new Uint8Array(readFileSync(join(TEMPLATE, path)));
			expect(files[path], `bytes for ${path}`).toEqual(onDisk);
		}
	});

	it("getStarterFile returns null for unknown paths", () => {
		expect(getStarterFile("does/not/exist.txt")).toBeNull();
	});

	it("getStarterFile returns same bytes as the map for known paths", () => {
		const path = "src/pages/index.astro";
		const map = getStarterFiles();
		expect(getStarterFile(path)).toEqual(map[path]);
	});

	it("returned map is fresh each call (defensive copy)", () => {
		const a = getStarterFiles();
		const b = getStarterFiles();
		// Mutating one doesn't affect the other.
		a["src/pages/index.astro"] = new Uint8Array([0xff]);
		expect(b["src/pages/index.astro"]?.[0]).not.toBe(0xff);
	});

	it("config.ts uses defineCollection with a Zod schema", () => {
		const bytes = getStarterFile("src/content/config.ts");
		expect(bytes).not.toBeNull();
		const text = new TextDecoder().decode(bytes as Uint8Array);
		expect(text).toContain("defineCollection");
		expect(text).toContain("z.object");
		expect(text).toContain("title:");
		expect(text).toContain("tags:");
	});

	it("dynamic route ships getStaticPaths and points to the blog collection", () => {
		const bytes = getStarterFile("src/pages/posts/[slug].astro");
		const text = new TextDecoder().decode(bytes as Uint8Array);
		expect(text).toContain("getStaticPaths");
		// The starter dynamic route doesn't import @astroflare/content
		// directly inside frontmatter — the preview module-graph doesn't
		// resolve npm package imports from .astro pages today. The route
		// instead points users at the blog collection in a comment so the
		// scaffold renders cleanly under preview while still demonstrating
		// the wiring.
		expect(text).toContain('getCollection("blog")');
	});
});
