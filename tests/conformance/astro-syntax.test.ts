/**
 * Astro-syntax conformance corpus — render-level.
 *
 * Each `astro-syntax/<name>.astro` fixture is a real-world pattern that
 * `@astrojs/compiler` accepts cleanly and that LLMs trained on the Astro
 * ecosystem reliably emit. The corpus seeded this suite from the Ember
 * integration's failure log (PRs #6/#8/#11/today) — the same patterns
 * that drove Astroflare's per-shape heuristic patches before the
 * `findMatchingBrace` scanner was switched to a real JS+JSX grammar
 * (acorn + acorn-jsx in PR #12) and JSX-in-expression bodies were
 * lowered through sucrase's classic JSX runtime to the runtime's
 * `$$jsx` / `$$Fragment` pragmas (PR #13, today).
 *
 * **Today's bar (render-level).** Each fixture compiles cleanly,
 * executes inside the in-process executor, and produces an HTML
 * string that contains the structural items each fixture's source
 * declares (e.g. for `jsx-from-map.astro` with `items = ["a", "b"]`,
 * the output contains `<li>a</li>` and `<li>b</li>`). The match is
 * substring-based rather than byte-for-byte to absorb whitespace
 * differences between sucrase's classic-JSX whitespace handling and
 * the upstream Astro renderer; the assertion still pins the
 * structural HTML the user asked for, which is the actual contract.
 *
 * **Yesterday's bar (parser-level).** Pre-PR-#12, the hand-rolled
 * brace scanner produced "Unclosed expression (missing `}`)" or
 * "Unterminated string literal" on these inputs. PR #12 swapped to
 * a real JS+JSX grammar and the corpus parsed cleanly but the JSX
 * tokens then crashed the downstream sucrase TS-strip pass. PR #13
 * configures sucrase's classic JSX transform with custom pragmas
 * pointing at runtime primitives, so the same source survives the
 * full compile + execute pipeline.
 *
 * Adding fixtures: drop a `<name>.astro` next to the existing ones,
 * with a corresponding entry in `RENDER_EXPECTATIONS`. No fixture
 * should rely on the `Astro.props` channel — they're stand-alone
 * tree-of-HTML smoke tests.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileAstro, parseAstro } from "@astroflare/compiler/astro";
import { renderToString } from "@astroflare/runtime/internal";
import { InProcessExecutor } from "@astroflare/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "astro-syntax");
const RUNTIME_DIST = path.resolve(__dirname, "../../packages/runtime/dist/internal.js");
const RUNTIME_URL = pathToFileURL(RUNTIME_DIST).href;

/**
 * Per-fixture render expectations. Each entry lists substrings the
 * compiled HTML output must contain, and (optionally) substrings it
 * must NOT contain. Whitespace inside the rendered HTML is normalised
 * to single spaces before assertions so JSX's whitespace-collapse
 * rules don't surface as false negatives.
 *
 * Why substrings: byte-equivalence against `@astrojs/compiler` would
 * couple the suite to Astro's exact whitespace + quoting choices,
 * and the contract Ember actually depends on is "the structural
 * HTML the user authored renders." Substring assertions pin every
 * tag and dynamic text the fixture declares without overspecifying
 * the surrounding whitespace.
 */
const RENDER_EXPECTATIONS: Record<
	string,
	{ contains: readonly string[]; absent?: readonly string[] }
> = {
	"jsx-from-map": {
		contains: ["<ul>", "<li>a</li>", "<li>b</li>", "</ul>"],
	},
	"jsx-with-attribute-expression": {
		contains: [`<a href="/posts/foo/">bar</a>`],
	},
	"chained-method-with-jsx": {
		contains: [`<a href="/foo/">bar</a>`],
		absent: [`<a href="/baz/">qux</a>`],
	},
	"ternary-with-jsx-branches": {
		contains: ["<details>open</details>"],
		absent: ["<summary>closed</summary>"],
	},
	"nested-jsx-with-conditional": {
		contains: ['<div class="image">[img]</div>', "<h3>x</h3>", "<p>Prep: 5m</p>"],
	},
	"multiline-attribute-in-jsx": {
		contains: ["<article", "background: var(--surface);", "<h3>Foo</h3>", "</article>"],
	},
	"self-closing-jsx": {
		contains: [
			`<img src="/x.png" alt="1"`,
			`<img src="/x.png" alt="2"`,
			`<img src="/x.png" alt="3"`,
		],
	},
	"jsx-component-invocation": {
		contains: [
			`<article class="card"><h3>Foo</h3></article>`,
			`<article class="card"><h3>Bar</h3></article>`,
		],
	},
	"jsx-fragment": {
		contains: ["<strong>a</strong>: ok", "<strong>b</strong>: ok"],
	},
	"jsx-spread-props": {
		contains: [`<span class="card" id="x">hello</span>`, `<span class="card" id="y">hello</span>`],
	},
	"jsx-member-tag": {
		contains: [`<section class="card">one</section>`, `<section class="card">two</section>`],
	},
	"jsx-conditional-rendering": {
		contains: ["<details>open content</details>"],
		absent: ["<summary>closed content</summary>"],
	},
};

const fixtureFiles = readdirSync(FIXTURE_DIR)
	.filter((f) => f.endsWith(".astro"))
	.sort();

let executor: InProcessExecutor;

beforeAll(() => {
	if (!existsSync(RUNTIME_DIST)) {
		throw new Error(`Runtime dist not found at ${RUNTIME_DIST}. Run \`pnpm build\` first.`);
	}
	executor = new InProcessExecutor();
});

afterAll(async () => {
	await executor.dispose();
});

async function renderFixture(source: string, filename: string): Promise<string> {
	const { code, errors } = await compileAstro(source, {
		runtimeImport: RUNTIME_URL,
		filename,
	});
	if (errors.length > 0) {
		throw new Error(`compile errors in ${filename}: ${JSON.stringify(errors, null, 2)}`);
	}
	const result = await executor.runOnce<unknown>(
		{
			mainModule: "main.js",
			modules: {
				"main.js": `export default async (input) => {
					const Component = (await import("./_inner.js")).default;
					return await Component({ Astro: { props: input.props } }, input.slots);
				};`,
				"_inner.js": code,
			},
		},
		{ props: {}, slots: {} },
	);
	return await renderToString(result);
}

function normaliseWhitespace(html: string): string {
	return html.replace(/\s+/g, " ").trim();
}

describe("astro-syntax conformance corpus", () => {
	if (fixtureFiles.length === 0) {
		throw new Error(`No fixtures found in ${FIXTURE_DIR}`);
	}

	for (const file of fixtureFiles) {
		const name = path.basename(file, ".astro");
		const source = readFileSync(path.join(FIXTURE_DIR, file), "utf8");

		it(`${name}: parses without errors`, () => {
			const { errors } = parseAstro(source);
			expect(errors).toEqual([]);
		});

		const expectation = RENDER_EXPECTATIONS[name];
		if (!expectation) {
			it.skip(`${name}: renders structural HTML (no expectation registered)`, () => {});
			continue;
		}
		it(`${name}: renders structural HTML`, async () => {
			const html = normaliseWhitespace(await renderFixture(source, `/${file}`));
			for (const needle of expectation.contains) {
				expect(html).toContain(normaliseWhitespace(needle));
			}
			for (const needle of expectation.absent ?? []) {
				expect(html).not.toContain(normaliseWhitespace(needle));
			}
		});
	}
});
