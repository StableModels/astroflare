import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newProject } from "./new.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "aflare-new-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("newProject (af new)", () => {
	it("creates the canonical starter scaffold", () => {
		const target = `${dir}/site`;
		const result = newProject({ dir: target });
		// Spot-check the headline files of the canonical starter.
		expect(result.created).toContain("astro.config.ts");
		expect(result.created).toContain("package.json");
		expect(result.created).toContain("src/layouts/Base.astro");
		expect(result.created).toContain("src/pages/index.astro");
		expect(result.created).toContain("src/pages/about.md");
		expect(result.created).toContain("src/pages/posts/[slug].astro");
		expect(result.created).toContain("src/content/blog/hello-world.md");
		expect(result.created).toContain("src/content/config.ts");
		expect(result.created).toContain("public/favicon.svg");
	});

	it("scaffolds the dynamic route with getStaticPaths", () => {
		const target = `${dir}/site`;
		newProject({ dir: target });
		const dynamicRoute = readFileSync(`${target}/src/pages/posts/[slug].astro`, "utf8");
		expect(dynamicRoute).toContain("getStaticPaths");
	});

	it("scaffolds a content collection with a Zod schema", () => {
		const target = `${dir}/site`;
		newProject({ dir: target });
		const config = readFileSync(`${target}/src/content/config.ts`, "utf8");
		expect(config).toContain("defineCollection");
		expect(config).toContain("z.object");
	});

	it("creates nested directories", () => {
		const target = `${dir}/site`;
		newProject({ dir: target });
		expect(existsSync(`${target}/src/pages/posts/[slug].astro`)).toBe(true);
		expect(existsSync(`${target}/src/content/blog/hello-world.md`)).toBe(true);
		expect(existsSync(`${target}/public/favicon.svg`)).toBe(true);
	});

	it("throws on a directory that already contains scaffold files unless force is set", () => {
		const target = `${dir}/site`;
		newProject({ dir: target });
		expect(() => newProject({ dir: target })).toThrow(/already contains scaffold files/);
	});

	it("force overwrites pre-existing files", () => {
		const target = `${dir}/site`;
		newProject({ dir: target });
		const indexPath = `${target}/src/pages/index.astro`;
		writeFileSync(indexPath, "tampered");
		const result = newProject({ dir: target, force: true });
		expect(result.skipped).toEqual([]);
		expect(readFileSync(indexPath, "utf8")).not.toBe("tampered");
	});
});
