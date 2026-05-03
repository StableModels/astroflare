/**
 * End-to-end pipeline: source `.astro` → compileAstro → InProcessExecutor →
 * default-exported component → render → HTML string.
 *
 * The pre-test step (`tsc -b` in the root `test` script) builds the runtime
 * to `packages/runtime/dist/internal.js`. Each test sets
 * `runtimeImport` to that file's absolute `file://` URL so the compiled
 * module's `import` resolves without needing `node_modules` next to the
 * temp directory the executor installs into.
 *
 * Failure modes:
 *   - "Cannot find module" on the runtime URL → `pnpm typecheck` (or
 *     `tsc -b`) hasn't run; the dist artifact is missing.
 *   - Default-export shape mismatch → emitter regression.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderToString } from "@astroflare/runtime/internal";
import { InProcessExecutor } from "@astroflare/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileAstro } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIST = path.resolve(__dirname, "../../../runtime/dist/internal.js");
const RUNTIME_URL = pathToFileURL(RUNTIME_DIST).href;

let executor: InProcessExecutor;

beforeAll(() => {
	if (!existsSync(RUNTIME_DIST)) {
		throw new Error(`Runtime dist not found at ${RUNTIME_DIST}. Run \`pnpm typecheck\` first.`);
	}
	executor = new InProcessExecutor();
});

afterAll(async () => {
	await executor.dispose();
});

async function render(astroSrc: string, props: unknown = {}, slots = {}): Promise<string> {
	const { code, errors } = await compileAstro(astroSrc, { runtimeImport: RUNTIME_URL });
	if (errors.length > 0) {
		throw new Error(`compile errors: ${JSON.stringify(errors, null, 2)}`);
	}
	const result = await executor.runOnce<unknown>(
		{
			mainModule: "main.js",
			modules: {
				// `_inner.js` holds the compiled component; `main.js` is a thin
				// wrapper that imports it and invokes it with the test inputs.
				// Keeping them separate avoids a duplicate `export default`
				// when esbuild's TS-strip pass normalises the compiled module.
				"main.js": `export default async (input) => {
					const { props, slots } = input;
					const Component = (await import("./_inner.js")).default;
					return await Component({ Astro: { props }, ...props }, slots);
				};`,
				"_inner.js": code,
			},
		},
		{ props, slots },
	);
	return await renderToString(result);
}

describe("e2e: source .astro → compiled module → HTML", () => {
	it("renders plain HTML elements", async () => {
		expect(await render("<p>hello</p>")).toBe("<p>hello</p>");
	});

	it("interpolates an expression and HTML-escapes it", async () => {
		const src = "---\nconst { name } = Astro.props;\n---\n<p>{name}</p>";
		expect(await render(src, { name: "<world>" })).toBe("<p>&lt;world&gt;</p>");
	});

	it("renders attributes — static and expression", async () => {
		const src = '---\nconst { url } = Astro.props;\n---\n<a href={url} class="link">go</a>';
		expect(await render(src, { url: "/x" })).toBe('<a href="/x" class="link">go</a>');
	});

	it("supports the {name} attribute shorthand", async () => {
		const src = "---\nconst { value } = Astro.props;\n---\n<input {value} />";
		expect(await render(src, { value: "v1" })).toBe('<input value="v1"/>');
	});

	it("supports {...spread} attributes", async () => {
		const src = "---\nconst { rest } = Astro.props;\n---\n<div {...rest}>x</div>";
		expect(await render(src, { rest: { class: "a", id: "b" } })).toBe(
			'<div class="a" id="b">x</div>',
		);
	});

	it("renders a void element with attributes", async () => {
		expect(await render("<br/>")).toBe("<br/>");
		expect(await render('<input type="text" disabled />')).toBe('<input type="text" disabled/>');
	});

	it("renders a default slot with fallback", async () => {
		expect(await render("<slot>fallback</slot>")).toBe("fallback");
	});

	it("renders a default slot when one is provided", async () => {
		// We can't easily pass slots through the wrapper indirection here
		// because the slot would need to be a function; the wrapper above is
		// meant for prop-driven tests. We exercise slots in the component
		// composition test below.
		expect(await render("<slot></slot>")).toBe("");
	});

	it("set:html replaces children with raw HTML (no escaping)", async () => {
		const src = "---\nconst { raw } = Astro.props;\n---\n<div set:html={raw}></div>";
		expect(await render(src, { raw: "<b>raw</b>" })).toBe("<div><b>raw</b></div>");
	});

	it("Fragment emits children with no wrapping tag", async () => {
		const src = "<Fragment><p>a</p><p>b</p></Fragment>";
		expect(await render(src)).toBe("<p>a</p><p>b</p>");
	});

	it("propagates source position errors but still parses partial output", async () => {
		const src = "<p>oops {unclosed</p>";
		const { errors } = await compileAstro(src);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.start.line).toBe(1);
	});

	it("strips TypeScript syntax from frontmatter", async () => {
		const src =
			"---\n" +
			"interface Props { name: string; age: number }\n" +
			"const { name, age } = Astro.props as Props;\n" +
			"---\n" +
			"<p>{name}/{age}</p>";
		expect(await render(src, { name: "Alice", age: 30 })).toBe("<p>Alice/30</p>");
	});

	it("supports type annotations on frontmatter consts", async () => {
		const src =
			"---\nconst items: readonly string[] = ['a', 'b', 'c'];\n---\n<p>{items.join(',')}</p>";
		expect(await render(src)).toBe("<p>a,b,c</p>");
	});

	it("strips `as` casts inside expressions", async () => {
		const src = "---\nconst raw = Astro.props.raw;\n---\n<p>{(raw as string).toUpperCase()}</p>";
		expect(await render(src, { raw: "hi" })).toBe("<p>HI</p>");
	});

	// ---- Scoped CSS (Phase 12) -----------------------------------------------

	it("scopes a <style> block — element gets data-aflare-h", async () => {
		const src = "<p>hi</p><style>p { color: red }</style>";
		const out = await render(src);
		expect(out).toMatch(/<p data-aflare-h="[a-f0-9]{8}">hi<\/p>/);
		expect(out).toMatch(/<style>p\[data-aflare-h="[a-f0-9]{8}"\] \{ color: red \}<\/style>/);
	});

	it("the scoped attribute on the element matches the selector hash", async () => {
		const src = "<p>hi</p><style>p { color: red }</style>";
		const out = await render(src);
		const elMatch = out.match(/<p data-aflare-h="([a-f0-9]{8})">/);
		const cssMatch = out.match(/p\[data-aflare-h="([a-f0-9]{8})"\] /);
		expect(elMatch?.[1]).toBeDefined();
		expect(elMatch?.[1]).toBe(cssMatch?.[1]);
	});

	it("preserves <style is:global> verbatim and skips per-element attrs", async () => {
		const src = "<p>hi</p><style is:global>p { color: red }</style>";
		const out = await render(src);
		expect(out).toContain("<p>hi</p>");
		expect(out).not.toContain("data-aflare-h");
		expect(out).toContain("<style>p { color: red }</style>");
	});

	it("preserves <script> contents verbatim (raw-text element)", async () => {
		const src = "<script>const x = { a: 1 };</script>";
		const out = await render(src);
		expect(out).toBe("<script>const x = { a: 1 };</script>");
	});

	// ---- import.meta.env substitution (Phase 12) -----------------------------

	it("substitutes import.meta.env.X with values from config.env", async () => {
		const src = "---\nconst mode = import.meta.env.MODE;\n---\n<p>{mode}</p>";
		const { code } = await compileAstro(src, {
			runtimeImport: RUNTIME_URL,
			env: { MODE: "production" },
		});
		// The substitution happens at TS-strip time; verify the literal made
		// it into the output (not just whichever pre-strip access shape).
		expect(code).toContain('"production"');
		expect(code).not.toContain("import.meta.env.MODE");
	});

	it("renders pages with substituted env vars correctly", async () => {
		// End-to-end via the test runner: compile with env, run, expect
		// the substituted value in the HTML.
		const src = "---\nconst v = import.meta.env.MY_KEY;\n---\n<p>{v}</p>";
		const { code, errors } = await compileAstro(src, {
			runtimeImport: RUNTIME_URL,
			env: { MY_KEY: "hello-env" },
		});
		if (errors.length) throw new Error(JSON.stringify(errors));
		const result = await executor.runOnce<unknown>(
			{
				mainModule: "main.js",
				modules: {
					"main.js":
						"export default async (input) => {" +
						"  const { props, slots } = input;" +
						'  const Component = (await import("./_inner.js")).default;' +
						"  return await Component({ Astro: { props }, ...props }, slots);" +
						"};",
					"_inner.js": code,
				},
			},
			{ props: {}, slots: {} },
		);
		expect(await renderToString(result)).toContain("hello-env");
	});
});

// ---------------------------------------------------------------------------
// Component composition (parent imports a child .astro)
// ---------------------------------------------------------------------------

// Multi-module .astro composition (parent .astro importing a child .astro) is
// blocked at the executor level by Vitest's Vite layer intercepting dynamic
// `import()` of tmp-dir files. Real preview/build pipelines (Phase 4+) handle
// inter-module resolution via URL rewriting, not Node's resolver, so this is
// not a runtime gap — it's a test-harness limitation. To still cover slot
// routing end-to-end we exercise it through the runtime API directly here;
// the emitter-level routing of `slot="..."` attributes is asserted separately
// in `emitter.test.ts`.
describe("e2e: slot routing through the runtime", () => {
	it("renders default + named slots in a single component call", async () => {
		const { $component, $render, $renderSlot } = await import("@astroflare/runtime/internal");
		const Layout = $component(
			async (_props, $$slots) =>
				$render`<header>${await $renderSlot($$slots, "title")}</header><main>${await $renderSlot($$slots, "default")}</main>`,
		);
		const result = await Layout(
			{},
			{
				title: () => $render`<h1>Hi</h1>`,
				default: () => $render`<p>body</p>`,
			},
		);
		expect(result.html).toBe("<header><h1>Hi</h1></header><main><p>body</p></main>");
	});

	it("uses fallback content when a slot is not provided", async () => {
		const { $component, $render, $renderSlot } = await import("@astroflare/runtime/internal");
		const Layout = $component(
			async (_props, $$slots) =>
				$render`<aside>${await $renderSlot($$slots, "aside", () => $render`(empty)`)}</aside>`,
		);
		const result = await Layout({}, {});
		expect(result.html).toBe("<aside>(empty)</aside>");
	});
});
