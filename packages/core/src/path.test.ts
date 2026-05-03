import { describe, expect, it } from "vitest";
import { dirname, joinPath, normalisePath, replaceExtension } from "./path.js";

describe("dirname", () => {
	it.each([
		["/src/pages/index.astro", "/src/pages"],
		["/index.astro", "/"],
		["index.astro", "."],
		["/", "/"],
	])("dirname(%j) === %j", (input, want) => {
		expect(dirname(input)).toBe(want);
	});
});

describe("normalisePath", () => {
	it.each([
		["/a/b/../c", "/a/c"],
		["/a/./b", "/a/b"],
		["/a/b/c/../../d", "/a/d"],
		["/a/", "/a"],
		["/", "/"],
		["./a/b", "a/b"],
		["../a", "../a"],
	])("normalisePath(%j) === %j", (input, want) => {
		expect(normalisePath(input)).toBe(want);
	});
});

describe("joinPath", () => {
	it.each([
		["/src/pages", "../components/Layout.astro", "/src/components/Layout.astro"],
		["/src/pages", "./about.astro", "/src/pages/about.astro"],
		["/src/pages", "/abs/path", "/abs/path"],
		["/", "x", "/x"],
		["/a/b", "../../c", "/c"],
	])("joinPath(%j, %j) === %j", (base, spec, want) => {
		expect(joinPath(base, spec)).toBe(want);
	});
});

describe("replaceExtension", () => {
	it("replaces a matching extension", () => {
		expect(replaceExtension("/x/Foo.astro", ".astro", ".js")).toBe("/x/Foo.js");
	});
	it("returns the original path if extension doesn't match", () => {
		expect(replaceExtension("/x/Foo.tsx", ".astro", ".js")).toBe("/x/Foo.tsx");
	});
});
