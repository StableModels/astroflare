import { describe, expect, it } from "vitest";
import { compileMdx } from "./index.js";

describe("compileMdx", () => {
	it("compiles basic Markdown to MDX output", async () => {
		const r = await compileMdx("# Hello\n\nWorld.\n");
		// MDX's emitted body references the JSX runtime aliases — the
		// import line should have been rewritten to a const decl.
		expect(r.code).not.toContain('from "@astroflare/runtime/jsx-runtime"');
		expect(r.code).toContain("function MDXContent");
		expect(r.code).toContain("export default $component");
		expect(r.code).toContain("export const frontmatter =");
	});

	it("parses YAML frontmatter and exposes it as a named export", async () => {
		const src = "---\ntitle: Hi\nslug: hello\ntags:\n  - a\n  - b\n---\n\n# Body\n";
		const r = await compileMdx(src);
		expect(r.frontmatter.title).toBe("Hi");
		expect(r.frontmatter.slug).toBe("hello");
		expect(r.frontmatter.tags).toEqual(["a", "b"]);
		expect(r.code).toContain('"title":"Hi"');
		expect(r.code).toContain('"tags":["a","b"]');
	});

	it("returns empty frontmatter when no YAML block is present", async () => {
		const r = await compileMdx("plain text\n");
		expect(r.frontmatter).toEqual({});
	});

	it("emits aliases for the jsx-runtime symbols at top of body", async () => {
		const r = await compileMdx("# x\n");
		// e.g. `const _jsx = jsx, _jsxs = jsxs, _Fragment = Fragment;`
		expect(r.code).toMatch(/const\s+_jsx\s*=\s*jsx/);
	});

	it("emits ESM that imports the runtime ABI", async () => {
		const r = await compileMdx("# x\n", { runtimeImport: "./runtime.js" });
		expect(r.code).toContain('from "./runtime.js"');
		expect(r.code).toContain("$component(");
	});

	it("throws on invalid YAML frontmatter", async () => {
		const src = "---\n: not: valid: yaml :\n---\n# body\n";
		await expect(compileMdx(src, { filename: "/x.mdx" })).rejects.toThrow(/invalid YAML/);
	});

	it("runs internal rehype plugins (Phase 14 Shiki rides this surface)", async () => {
		// Spy plugin: drop a marker comment into the AST root so we can
		// verify the rehype phase ran.
		const marker: import("unified").Plugin = () => {
			return (tree: import("hast").Root) => {
				tree.children.unshift({ type: "comment", value: "ran" });
			};
		};
		const r = await compileMdx("# hi\n", { rehypePlugins: [marker] });
		expect(r.code).toContain("ran");
	});

	it("supports JSX expressions inline (the whole point of MDX)", async () => {
		const src = "# Greeting\n\n<button onClick={() => 0}>click</button>\n";
		const r = await compileMdx(src);
		// MDX compiles the JSX into _jsx calls — the literal string
		// "button" should show up inside the function body.
		expect(r.code).toMatch(/_jsx\(\s*['"]button['"]/);
	});

	it("frontmatter survives JSON round-trip in emitted code", async () => {
		const src = '---\ntitle: "Quotes & ampersands"\n---\n\nbody\n';
		const r = await compileMdx(src);
		expect(r.frontmatter.title).toBe("Quotes & ampersands");
		// JSON.stringify escapes nothing special here, but the assertion
		// proves the value made it through unmodified.
		expect(r.code).toContain('"Quotes & ampersands"');
	});
});
