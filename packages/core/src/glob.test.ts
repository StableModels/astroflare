import { describe, expect, it } from "vitest";
import { globMatch, globToRegex } from "./glob.js";

describe("glob matcher", () => {
	it.each([
		["*.ts", "foo.ts", true],
		["*.ts", "foo.tsx", false],
		["*.ts", "a/b.ts", false], // single * does not cross /
		["**/*.ts", "a/b/c.ts", true],
		["**/*.ts", "c.ts", true],
		["src/**/*.astro", "src/pages/index.astro", true],
		["src/**/*.astro", "src/pages/posts/one.astro", true],
		["src/**/*.astro", "other/x.astro", false],
		["?ello", "hello", true],
		["?ello", "hellos", false],
		["literal.txt", "literal.txt", true],
		["a.b.c", "a.b.c", true],
		["a.b.c", "a-b-c", false],
	])("globMatch(%j, %j) === %s", (pattern, path, want) => {
		expect(globMatch(pattern, path)).toBe(want);
	});

	it("regex compiles even for empty pattern", () => {
		expect(globToRegex("").test("")).toBe(true);
	});
});
