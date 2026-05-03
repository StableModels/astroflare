/**
 * Tests for `transformTS` — the esbuild-wasm-backed TS-strip helper.
 *
 * esbuild-wasm initialises once per process; subsequent test imports of
 * this module reuse the same instance, so timings after the first call
 * are sub-ms.
 */
import { describe, expect, it } from "vitest";
import { transformTS } from "./ts.js";

describe("transformTS", () => {
	it("strips TS type annotations from a const declaration", async () => {
		const out = await transformTS("const x: number = 1;");
		expect(out).toContain("const x = 1");
		expect(out).not.toContain(": number");
	});

	it("strips function parameter type annotations", async () => {
		const out = await transformTS("function add(a: number, b: number): number { return a + b; }");
		expect(out).toContain("function add(a, b)");
		expect(out).toContain("return a + b");
	});

	it("strips interface declarations entirely", async () => {
		const out = await transformTS("interface Foo { x: number }\nconst v: Foo = { x: 1 };");
		expect(out).not.toContain("interface");
		expect(out).toContain("const v = { x: 1 }");
	});

	it("strips `as` casts", async () => {
		const out = await transformTS("const x = (1 as number) + 2;");
		expect(out).toContain("const x = 1 + 2");
		expect(out).not.toContain("as number");
	});

	it("preserves ESM import / export structure", async () => {
		const src = ['import { x } from "./mod";', "export const y: number = x + 1;"].join("\n");
		const out = await transformTS(src);
		expect(out).toContain('from "./mod"');
		expect(out).toContain("y");
	});

	it("plain JS passes through unchanged in semantics", async () => {
		const src = "const x = 1;\nexport default x + 2;";
		const out = await transformTS(src);
		expect(out).toContain("x = 1");
		// The default-export expression `x + 2` is preserved (esbuild
		// rewrites to `var stdin_default = x + 2; export { stdin_default
		// as default };` but the operand expression is intact).
		expect(out).toContain("x + 2");
		expect(out).not.toContain("undefined");
	});

	it("rejects genuine syntax errors", async () => {
		await expect(transformTS("const x = ;")).rejects.toThrow();
	});
});
