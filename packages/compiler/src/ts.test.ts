/**
 * Tests for `transformTS` — the sucrase-backed TS-strip helper.
 *
 * Pure-JS, sync under the hood. Backward-compatible async signature.
 * No WASM, no init step, runs identically in Node and workerd.
 */
import { describe, expect, it } from "vitest";
import { transformTS } from "./ts.js";

/**
 * Sanity-check that the stripper output is valid JavaScript: parsing
 * it via the `Function` constructor throws on syntax errors. We don't
 * actually execute the function (`new Function(out)` would only catch
 * parse-time errors, not runtime ones), which is exactly what we want
 * — the embedder fix surface is "does V8 reject this as un-parseable
 * JS." Anything that lands in the spawned isolate has to clear that
 * bar.
 */
function expectParseable(source: string): void {
	expect(() => new Function(source)).not.toThrow();
}

describe("transformTS", () => {
	it("strips TS type annotations from a const declaration", async () => {
		const out = await transformTS("const x: number = 1;");
		expect(out).toContain("const x");
		expect(out).toContain("= 1");
		expect(out).not.toContain(": number");
		expectParseable(out);
	});

	it("strips function parameter type annotations", async () => {
		const out = await transformTS("function add(a: number, b: number): number { return a + b; }");
		expect(out).toContain("function add(a");
		expect(out).toContain("b");
		expect(out).toContain("return a + b");
		expect(out).not.toContain(": number");
		expectParseable(out);
	});

	it("strips interface declarations entirely", async () => {
		const out = await transformTS("interface Foo { x: number }\nconst v: Foo = { x: 1 };");
		expect(out).not.toContain("interface");
		expect(out).toContain("{ x: 1 }");
		expectParseable(out);
	});

	it("strips type aliases entirely", async () => {
		const out = await transformTS("type Foo = { x: number };\nconst v = { x: 1 };");
		expect(out).not.toContain("type Foo");
		expect(out).toContain("const v = { x: 1 }");
		expectParseable(out);
	});

	it("strips `as` casts", async () => {
		const out = await transformTS("const x = (1 as number) + 2;");
		// Sucrase preserves source positions: it blanks the cast bytes
		// rather than collapsing whitespace. The output is still valid
		// parsable JS.
		expect(out).not.toContain("as number");
		expectParseable(out);
	});

	it("strips generic type parameters on a function", async () => {
		const out = await transformTS("function id<T>(x: T): T { return x; }");
		expect(out).not.toContain("<T>");
		expect(out).not.toContain(": T");
		expect(out).toContain("function id");
		expect(out).toContain("return x");
		expectParseable(out);
	});

	it("strips an enum declaration to a runtime object literal", async () => {
		const out = await transformTS("enum Direction { Up, Down }\nconst d = Direction.Up;");
		// Sucrase compiles `enum` to an IIFE; the keyword shouldn't
		// survive into the emitted JS.
		expect(out).not.toMatch(/^\s*enum\b/m);
		expectParseable(out);
	});

	it("preserves ESM import / export structure", async () => {
		const src = ['import { x } from "./mod";', "export const y: number = x + 1;"].join("\n");
		const out = await transformTS(src);
		expect(out).toContain('from "./mod"');
		expect(out).toContain("export const y");
		expect(out).toContain("x + 1");
	});

	it("plain JS passes through with semantics intact", async () => {
		const src = "const x = 1;\nexport default x + 2;";
		const out = await transformTS(src);
		expect(out).toContain("x = 1");
		expect(out).toContain("x + 2");
	});

	it("rejects genuine syntax errors", async () => {
		await expect(transformTS("const x = ;")).rejects.toThrow();
	});

	it("substitutes import.meta.env.<KEY> from define", async () => {
		const out = await transformTS("const m = import.meta.env.MODE;", {
			define: { "import.meta.env.MODE": JSON.stringify("production") },
		});
		expect(out).toContain('"production"');
		expect(out).not.toContain("import.meta.env.MODE");
		expectParseable(out);
	});

	it("substitutes only exact-match define keys (no partial overlap)", async () => {
		const src = "const a = import.meta.env.MODE;\nconst b = import.meta.env.MODE_X;";
		const out = await transformTS(src, {
			define: { "import.meta.env.MODE": JSON.stringify("p") },
		});
		expect(out).toContain('const a = "p"');
		// MODE_X must not match MODE.
		expect(out).toContain("import.meta.env.MODE_X");
	});

	it("surfaces filename in error messages when supplied", async () => {
		await expect(
			transformTS("const x: = 5;", { filename: "/src/pages/bad.astro" }),
		).rejects.toThrow(/bad\.astro/);
	});
});
