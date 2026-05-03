import { describe, expect, it } from "vitest";
import { extractImports, rewriteImports } from "./url-rewrite.js";

describe("extractImports", () => {
	it("captures default, named, namespace, and bare imports", () => {
		const code = `
			import a from "./a.js";
			import { b, c } from "./b.js";
			import * as ns from "./ns.js";
			import "./bare.js";
		`;
		expect(extractImports(code).sort()).toEqual(["./a.js", "./b.js", "./bare.js", "./ns.js"]);
	});

	it("captures `export … from` re-exports", () => {
		const code = `export { x } from "./x.js"; export * from "./y.js";`;
		expect(extractImports(code).sort()).toEqual(["./x.js", "./y.js"]);
	});

	it("captures dynamic imports", () => {
		const code = `const m = await import("./dyn.js");`;
		expect(extractImports(code)).toEqual(["./dyn.js"]);
	});

	it("dedupes identical specifiers", () => {
		const code = `import a from "./a.js"; import b from "./a.js";`;
		expect(extractImports(code)).toEqual(["./a.js"]);
	});

	it("returns empty for code without imports", () => {
		expect(extractImports("const x = 1;")).toEqual([]);
	});
});

describe("rewriteImports", () => {
	it("rewrites the specifier of a static import", () => {
		const code = `import X from "./X.astro";`;
		const out = rewriteImports(code, (s) => s.replace(/\.astro$/, ".js"));
		expect(out).toBe(`import X from "./X.js";`);
	});

	it("rewrites multiple imports independently", () => {
		const code = `
			import L from "./Layout.astro";
			import B from "./Button.astro";
			import { x } from "./util.js";
		`;
		const out = rewriteImports(code, (s) =>
			s.endsWith(".astro") ? s.replace(/\.astro$/, ".js") : s,
		);
		expect(out).toContain('"./Layout.js"');
		expect(out).toContain('"./Button.js"');
		expect(out).toContain('"./util.js"');
	});

	it("rewrites bare specifiers", () => {
		const code = `import { x } from "@astroflare/runtime";`;
		const out = rewriteImports(code, () => "/runtime.js");
		expect(out).toBe(`import { x } from "/runtime.js";`);
	});

	it("rewrites dynamic imports", () => {
		const code = `const m = await import("./mod.astro");`;
		const out = rewriteImports(code, (s) => s.replace(/\.astro$/, ".js"));
		expect(out).toBe(`const m = await import("./mod.js");`);
	});

	it("preserves the rest of the source verbatim", () => {
		const code = `// comment\nimport X from "./X.astro";\nconst y = 1;\n`;
		const out = rewriteImports(code, (s) => s.replace(/\.astro$/, ".js"));
		expect(out).toBe(`// comment\nimport X from "./X.js";\nconst y = 1;\n`);
	});

	it("handles single-quoted specifiers", () => {
		const code = `import a from './a.astro';`;
		const out = rewriteImports(code, (s) => s.replace(/\.astro$/, ".js"));
		expect(out).toBe(`import a from './a.js';`);
	});

	it("identity rewrite leaves source unchanged", () => {
		const code = `import a from "./a.js"; import { b } from "./b.js";`;
		expect(rewriteImports(code, (s) => s)).toBe(code);
	});

	it("handles import without 'from' clause", () => {
		const code = `import "./side-effect.js";`;
		const out = rewriteImports(code, (s) => `${s}?v=1`);
		expect(out).toBe(`import "./side-effect.js?v=1";`);
	});
});
