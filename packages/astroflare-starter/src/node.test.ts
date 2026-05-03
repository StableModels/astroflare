/**
 * `@astroflare/starter/node` on-disk materialisation tests.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getStarterFiles, starterFilePaths } from "./index.js";
import { writeStarterFiles } from "./node.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {}
	}
});

function freshDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "aflare-starter-test-"));
	dirs.push(dir);
	return dir;
}

describe("writeStarterFiles", () => {
	it("creates every canonical file", () => {
		const dir = freshDir();
		const result = writeStarterFiles({ dir });
		expect([...result.created].sort()).toEqual([...starterFilePaths].sort());
		expect(result.skipped).toEqual([]);

		// Every reported `created` file actually exists on disk.
		for (const path of result.created) {
			const full = join(dir, path);
			expect(existsSync(full), full).toBe(true);
			expect(statSync(full).isFile()).toBe(true);
		}
	});

	it("produces files byte-identical to getStarterFiles()", () => {
		const dir = freshDir();
		writeStarterFiles({ dir });
		const map = getStarterFiles();
		for (const path of starterFilePaths) {
			const onDisk = new Uint8Array(readFileSync(join(dir, path)));
			expect(onDisk, `disk bytes for ${path}`).toEqual(map[path]);
		}
	});

	it("creates nested directories (e.g. src/pages/posts/)", () => {
		const dir = freshDir();
		writeStarterFiles({ dir });
		expect(existsSync(join(dir, "src/pages/posts/[slug].astro"))).toBe(true);
		expect(existsSync(join(dir, "src/content/blog/hello-world.md"))).toBe(true);
	});

	it("throws when destination has conflicting files and force is not set", () => {
		const dir = freshDir();
		// Pre-seed a conflict.
		writeStarterFiles({ dir });
		expect(() => writeStarterFiles({ dir })).toThrow(/already contains scaffold files/);
	});

	it("force: true overwrites pre-existing files", () => {
		const dir = freshDir();
		writeStarterFiles({ dir });
		const indexPath = join(dir, "src/pages/index.astro");
		writeFileSync(indexPath, "tampered");
		const result = writeStarterFiles({ dir, force: true });
		expect(result.skipped).toEqual([]);
		expect(readFileSync(indexPath, "utf8")).not.toBe("tampered");
	});

	it("on-disk + programmatic produce byte-identical output", () => {
		const dir = freshDir();
		writeStarterFiles({ dir });
		const programmatic = getStarterFiles();
		for (const path of starterFilePaths) {
			expect(new Uint8Array(readFileSync(join(dir, path)))).toEqual(programmatic[path]);
		}
	});
});
