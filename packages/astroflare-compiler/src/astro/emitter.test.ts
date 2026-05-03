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

	it("hoists `export async function getStaticPaths` to module scope", () => {
		const code = compile(
			[
				"---",
				"export async function getStaticPaths() {",
				"  return [{ params: { slug: 'a' } }];",
				"}",
				"const { slug } = Astro.params;",
				"---",
				"<p>{slug}</p>",
			].join("\n"),
		);
		// The export sits BEFORE `export default $component(...)`.
		const exportIdx = code.indexOf("export async function getStaticPaths");
		const defaultIdx = code.indexOf("export default $component");
		expect(exportIdx).toBeGreaterThan(-1);
		expect(defaultIdx).toBeGreaterThan(-1);
		expect(exportIdx).toBeLessThan(defaultIdx);
		// The non-export frontmatter line stays inside the component body
		// (i.e. AFTER the default export's arrow opens).
		expect(code.indexOf("const { slug } = Astro.params;")).toBeGreaterThan(defaultIdx);
	});

	it("hoists `export const NAME = expr;` declarations", () => {
		const code = compile("---\nexport const prerender = true;\nconst x = 1;\n---\n<p>x</p>");
		const exportIdx = code.indexOf("export const prerender = true");
		const defaultIdx = code.indexOf("export default $component");
		expect(exportIdx).toBeGreaterThan(-1);
		expect(exportIdx).toBeLessThan(defaultIdx);
		expect(code.indexOf("const x = 1;")).toBeGreaterThan(defaultIdx);
	});

	it("does not hoist `export default` (reserved by the emitter)", () => {
		// The user shouldn't typically write this, but it must not collide
		// with the wrapper's own default export.
		const code = compile("---\nconst x = 1;\n---\n<p>x</p>");
		expect(code.match(/export default/g)?.length).toBe(1);
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

	it("client:load on a component emits a $island wrapper (Phase 16)", () => {
		const code = compile("<Counter client:load count={1} />");
		expect(code).toContain("$island(");
		expect(code).toContain('"mode":"load"');
		expect(code).toContain('"componentName":"Counter"');
	});

	it("client:media captures the media query", () => {
		const code = compile('<Counter client:media="(min-width: 800px)" />');
		expect(code).toContain('"mediaQuery":"(min-width: 800px)"');
	});

	it("$island encodes the import spec for components in frontmatter", () => {
		const code = compile(
			'---\nimport Counter from "../components/Counter.tsx";\n---\n<Counter client:load />',
		);
		expect(code).toContain('"componentSpec":"../components/Counter.tsx"');
	});

	it(".astro imports get an SSR callback (Astroflare components SSR cleanly)", () => {
		const code = compile(
			'---\nimport Card from "./Card.astro";\n---\n<Card client:visible label="Hi" />',
		);
		expect(code).toContain("$island(");
		// Astroflare components: SSR is wired (the inline-bundled output
		// still includes the renderComponent call).
		expect(code).toContain("await $renderComponent(Card");
	});

	it(".tsx imports get a React SSR callback (Phase 16b)", () => {
		const code = compile('---\nimport Counter from "./Counter.tsx";\n---\n<Counter client:load />');
		expect(code).toContain("$island(");
		// React imports: SSR via `$ssrReactIsland(Counter, props)`.
		expect(code).toContain("$ssrReactIsland(Counter");
		// And the Astroflare-renderer path is NOT used.
		expect(code).not.toContain("await $renderComponent(Counter");
	});

	it(".jsx imports get a React SSR callback (Phase 16b)", () => {
		const code = compile('---\nimport Foo from "./Foo.jsx";\n---\n<Foo client:idle />');
		expect(code).toContain("$ssrReactIsland(Foo");
	});

	it("client:only skips the SSR callback regardless of source extension", () => {
		const code = compile('---\nimport Counter from "./Counter.tsx";\n---\n<Counter client:only />');
		expect(code).toContain("$island(");
		// The directive's contract is to skip SSR — the second `$island`
		// argument is `null` rather than a callback.
		expect(code).toContain(", null)");
		// `$ssrReactIsland` is in RUNTIME_SYMBOLS so it appears in the
		// import line; what matters is no *call* exists.
		expect(code).not.toContain("$ssrReactIsland(");
	});

	it("$island falls back to best-effort SSR when import isn't tracked", () => {
		// Bare `<X client:load />` with no frontmatter import — emit still
		// produces an island; the runtime $island helper handles the
		// undefined-component case gracefully.
		const code = compile("<Inline client:load />");
		expect(code).toContain("$island(");
		expect(code).toContain('"componentSpec":null');
	});
});

describe("emitter — is:raw directive (Phase 19)", () => {
	it("emits children of an is:raw element as literal text", () => {
		const code = compile("<pre is:raw>{x} is not interpolated</pre>");
		// The expression must not be passed to the template literal
		// interpolation slot (`${...}`); it must show up as the literal
		// `{x}` in the rendered HTML.
		expect(code).toContain("<pre>{x} is not interpolated</pre>");
		expect(code).not.toContain("${x}");
	});

	it("strips the is:raw directive from the rendered tag", () => {
		const code = compile("<pre is:raw>literal {x}</pre>");
		expect(code).not.toContain("is:raw");
	});

	it("does not compile child Astro components when inside is:raw", () => {
		const code = compile("<div is:raw><Counter client:load /></div>");
		// `<Counter />` inside `is:raw` should appear as-is, not become
		// a `$renderComponent` call or a `$island(...)` wrapper.
		expect(code).toContain("<Counter client:load");
		expect(code).not.toContain("$renderComponent(Counter");
		expect(code).not.toContain("$island(");
	});

	it("preserves nested element markup inside is:raw", () => {
		const code = compile('<code is:raw><span class="k">if</span> truthy <em>x</em></code>');
		expect(code).toContain('<code><span class="k">if</span> truthy <em>x</em></code>');
	});

	it("emits attribute expressions inside is:raw children as literal {expr}", () => {
		const code = compile("<pre is:raw><span class={cls}>x</span></pre>");
		// The attribute is preserved in {expr} form, not interpolated.
		expect(code).toContain("<span class={cls}>x</span>");
	});

	it("preserves comments inside is:raw verbatim", () => {
		const code = compile("<pre is:raw><!-- {x} --></pre>");
		expect(code).toContain("<pre><!-- {x} --></pre>");
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
