import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "./init.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "aflare-init-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("initProject", () => {
	it("creates the canonical scaffold", () => {
		// initProject expects a path it can populate. Use a non-existent
		// child directory to mimic the real CLI's behaviour.
		const target = `${dir}/site`;
		const result = initProject({ dir: target });
		expect(result.created).toContain("aflare.config.json");
		expect(result.created).toContain("package.json");
		expect(result.created).toContain("src/pages/index.astro");
		expect(result.created).toContain("src/pages/about.astro");
		expect(result.created).toContain(".gitignore");
	});

	it("aflare.config.json is valid JSON with the project's site URL", () => {
		const target = `${dir}/site`;
		initProject({ dir: target, site: "https://my.example/" });
		const cfg = JSON.parse(readFileSync(`${target}/aflare.config.json`, "utf8"));
		expect(cfg.site).toBe("https://my.example/");
		expect(cfg.output).toBe("static");
	});

	it("package.json picks up the explicit `name` option", () => {
		const target = `${dir}/site`;
		initProject({ dir: target, name: "blog" });
		const pkg = JSON.parse(readFileSync(`${target}/package.json`, "utf8"));
		expect(pkg.name).toBe("blog");
		expect(pkg.scripts.deploy).toBe("af deploy");
	});

	it("falls back to the directory's basename when name is omitted", () => {
		const target = `${dir}/my-shiny-site`;
		initProject({ dir: target });
		const pkg = JSON.parse(readFileSync(`${target}/package.json`, "utf8"));
		expect(pkg.name).toBe("my-shiny-site");
	});

	it("throws on a non-empty directory unless force is set", () => {
		const target = `${dir}/site`;
		initProject({ dir: target });
		expect(() => initProject({ dir: target })).toThrow(/not empty/);
	});

	it("force re-runs over an existing directory and re-creates files", () => {
		const target = `${dir}/site`;
		initProject({ dir: target });
		const result = initProject({ dir: target, force: true });
		expect(result.created.length).toBeGreaterThan(0);
		expect(result.skipped.length).toBe(0);
	});

	it("the index.astro greets the user (sanity check)", () => {
		const target = `${dir}/site`;
		initProject({ dir: target });
		const html = readFileSync(`${target}/src/pages/index.astro`, "utf8");
		expect(html).toContain("Hello, Astroflare");
		expect(html).toContain('<a href="/about">');
	});
});
