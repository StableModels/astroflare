import { describe, expect, it } from "vitest";
import { emitDocument } from "./emitter.js";
import { parseAstro } from "./parser.js";

const compile = (src: string) => emitDocument(parseAstro(src).doc).code;

describe("emitter — module shape", () => {
	it("emits the runtime import + default-exported $component", () => {
		const code = compile("<p>hi</p>");
		expect(code).toMatch(/from "@astroflare\/runtime\/internal"/);
		expect(code).toMatch(
			/export default \$component\(async \(\{ Astro, \.\.\.\$\$props \}, \$\$slots\) =>/,
		);
		expect(code).toMatch(/return \$render`/);
	});

	it("respects a custom runtimeImport", () => {
		const r = emitDocument(parseAstro("<p>x</p>").doc, {
			runtimeImport: "./custom.js",
		});
		expect(r.code).toMatch(/from "\.\/custom\.js"/);
	});

	it("passes frontmatter through verbatim", () => {
		const code = compile("---\nimport X from './X.astro';\nconst y = 1;\n---\n<p>{y}</p>");
		expect(code).toContain("import X from './X.astro';");
		expect(code).toContain("const y = 1;");
	});
});

describe("emitter — text and expressions", () => {
	it("escapes backticks in text (template-literal safe)", () => {
		const code = compile("hello `world`");
		expect(code).toContain("hello \\`world\\`");
	});

	it("escapes a backslash in text", () => {
		const code = compile("path C:\\foo");
		// Source `\` becomes `\\` in the emitted template literal.
		expect(code).toContain("path C:\\\\foo");
	});

	it("emits `${expr}` for content expressions", () => {
		const code = compile("{name}");
		expect(code).toContain("${name}");
	});
});

describe("emitter — elements and attributes", () => {
	it("emits a void element as self-closing", () => {
		const code = compile("<br>");
		expect(code).toMatch(/<br\/>/);
	});

	it("static attribute → literal HTML", () => {
		const code = compile('<a href="/x">y</a>');
		expect(code).toContain('href="/x"');
	});

	it("expression attribute → $attrPair call", () => {
		const code = compile("<a href={url}>x</a>");
		expect(code).toContain('${$attrPair("href", url)}');
	});

	it("shorthand attribute → $attrPair call with bare name", () => {
		const code = compile("<input {value} />");
		expect(code).toContain('${$attrPair("value", value)}');
	});

	it("spread attribute → $spreadAttrs call", () => {
		const code = compile("<div {...rest}>x</div>");
		expect(code).toContain("${$spreadAttrs(rest)}");
	});

	it("boolean attribute → ` name`", () => {
		const code = compile("<input disabled />");
		expect(code).toContain(" disabled");
	});
});

describe("emitter — components", () => {
	it("emits an await $renderComponent call", () => {
		const code = compile('<Layout title="X">child</Layout>');
		expect(code).toMatch(
			/\$\{await \$renderComponent\(Layout, \{ title: "X" \}, \{ default: async \(\) => \$render`child` \}\)\}/,
		);
	});

	it('partitions children into named slots based on slot="name"', () => {
		const code = compile('<Layout><p slot="aside">side</p><h1>main</h1></Layout>');
		expect(code).toContain("default: async () => $render`<h1>main</h1>`");
		expect(code).toContain("aside: async () => $render`<p>side</p>`");
	});

	it("self-closing component with no children → empty slots object", () => {
		const code = compile("<Counter count={3} />");
		expect(code).toMatch(/\$renderComponent\(Counter, \{ count: \(3\) \}, \{\}\)/);
	});

	it("dotted component name passes through verbatim", () => {
		const code = compile("<UI.Button label='Hi' />");
		expect(code).toContain("$renderComponent(UI.Button,");
	});
});

describe("emitter — slots", () => {
	it('default slot → $renderSlot($$slots, "default")', () => {
		const code = compile("<slot />");
		expect(code).toContain('await $renderSlot($$slots, "default")');
	});

	it('named slot → $renderSlot($$slots, "header")', () => {
		const code = compile('<slot name="header" />');
		expect(code).toContain('await $renderSlot($$slots, "header")');
	});

	it("slot with fallback content emits a fallback fn", () => {
		const code = compile("<slot>fallback</slot>");
		expect(code).toContain("async () => $render`");
		expect(code).toContain("fallback");
	});
});

describe("emitter — directives", () => {
	it("set:html replaces children with $rawHtml(...)", () => {
		const code = compile("<div set:html={raw}>ignored</div>");
		expect(code).toContain("${$rawHtml(raw)}");
		expect(code).not.toContain("ignored");
	});

	it("define:vars on <script> prepends a const block", () => {
		const code = compile("<script define:vars={{ user }}>console.log(user)</script>");
		expect(code).toContain("$defineVars({ user })");
	});

	it("client:load on a component emits a hydration marker", () => {
		const code = compile("<Counter client:load count={1} />");
		expect(code).toContain("$hydrationMarker(");
		expect(code).toContain('"mode":"load"');
	});

	it("client:media captures the media query", () => {
		const code = compile('<Counter client:media="(min-width: 800px)" />');
		expect(code).toContain('"mediaQuery":"(min-width: 800px)"');
	});
});

describe("emitter — fragments and comments", () => {
	it("Fragment flattens children with no wrapping element", () => {
		const code = compile("<Fragment><p>a</p><p>b</p></Fragment>");
		expect(code).toContain("<p>a</p><p>b</p>");
		expect(code).not.toContain("<Fragment>");
	});

	it("preserves HTML comments", () => {
		const code = compile("<!-- TODO --><p>x</p>");
		expect(code).toContain("<!-- TODO -->");
	});

	it("emits a doctype literally", () => {
		const code = compile("<!doctype html>\n<html></html>");
		expect(code).toContain("<!doctype html>");
	});
});
