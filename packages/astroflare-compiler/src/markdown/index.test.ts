import { describe, expect, it } from "vitest";
import { compileMarkdown } from "./index.js";

describe("compileMarkdown", () => {
	it("renders basic markdown to HTML", async () => {
		const r = await compileMarkdown("# Hello\n\nWorld.\n");
		expect(r.html).toContain("<h1>Hello</h1>");
		expect(r.html).toContain("<p>World.</p>");
	});

	it("parses YAML frontmatter and exposes it", async () => {
		const src = "---\ntitle: Hi\nslug: hello\ntags: [a, b]\n---\n# Body\n";
		const r = await compileMarkdown(src);
		expect(r.frontmatter.title).toBe("Hi");
		expect(r.frontmatter.slug).toBe("hello");
		expect(r.frontmatter.tags).toEqual(["a", "b"]);
		expect(r.html).toContain("<h1>Body</h1>");
	});

	it("returns empty frontmatter for files without `---` block", async () => {
		const r = await compileMarkdown("plain text");
		expect(r.frontmatter).toEqual({});
		expect(r.html).toContain("plain text");
	});

	it("emits ESM that imports the runtime ABI", async () => {
		const r = await compileMarkdown("hi", { runtimeImport: "./runtime.js" });
		expect(r.code).toContain('from "./runtime.js"');
		expect(r.code).toContain("$component(");
		expect(r.code).toContain("export default $component");
		// Frontmatter is a local const (not a named export) so the inline
		// bundler's IIFE wrap doesn't choke on `export const` inside a function.
		expect(r.code).toContain("const frontmatter =");
		expect(r.code).not.toContain("export const frontmatter");
	});

	it("preserves embedded HTML (allowDangerousHtml)", async () => {
		const r = await compileMarkdown("Para with <em>html</em>.\n");
		expect(r.html).toContain("<em>html</em>");
	});

	it("throws on malformed YAML frontmatter", async () => {
		const src = "---\n: not: valid: yaml :\n---\n";
		await expect(compileMarkdown(src, { filename: "/x.md" })).rejects.toThrow(/invalid YAML/);
	});

	it("frontmatter survives JSON roundtrip in emitted code", async () => {
		const src = '---\ntitle: "Hi"\ntags: [a, b]\n---\nBody';
		const r = await compileMarkdown(src);
		// The emitted code should contain the JSON-encoded frontmatter.
		expect(r.code).toContain('"title":"Hi"');
		expect(r.code).toContain('"tags":["a","b"]');
	});
});
