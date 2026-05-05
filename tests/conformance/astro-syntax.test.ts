/**
 * Astro-syntax conformance corpus — parser-level.
 *
 * Each `astro-syntax/<name>.astro` fixture is a real-world pattern that
 * `@astrojs/compiler` accepts cleanly and that LLMs trained on the Astro
 * ecosystem reliably emit. The corpus seeded this suite from the Ember
 * integration's failure log (PRs #6/#8/#11/today) — the same patterns
 * that drove Astroflare's per-shape heuristic patches before the
 * `findMatchingBrace` scanner was switched to a real JS+JSX grammar
 * (acorn + acorn-jsx).
 *
 * **Today's bar (parser-level).** Every fixture must parse without
 * errors. The previous hand-rolled scanner produced "Unclosed
 * expression (missing `}`)" or "Unterminated string literal" on these
 * inputs — the parser swap closes that gap.
 *
 * **Tomorrow's bar (renders equivalently).** The full Ember ask is
 * that each fixture *renders* to HTML structurally equivalent to what
 * `@astrojs/compiler` produces. Reaching it requires a follow-up to
 * the emitter: JSX inside expression bodies (`{items.map((x) => (<li>…</li>))}`)
 * currently flows through verbatim into the emitted template literal,
 * and the downstream sucrase TS-strip pass rejects the bare JSX (TS
 * mode treats `<li>` as a type assertion). The fix is recursive
 * emission — walk the AST acorn-jsx returns, compile any JSXElement /
 * JSXFragment children into Astroflare's `$render` template-literal
 * shape — but it's a separate change with its own design space (slot
 * semantics for JSX children, scope-hash propagation, source-map
 * accounting). This corpus stays in place so when that work lands
 * the assertion can be promoted to "renders to expected HTML"
 * fixture-by-fixture, not retro-fitted from scratch.
 *
 * Adding fixtures: drop a `<name>.astro` next to the existing ones.
 * No registration needed — the suite walks `astro-syntax/`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAstro } from "@astroflare/compiler/astro";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "astro-syntax");

const fixtureFiles = readdirSync(FIXTURE_DIR)
	.filter((f) => f.endsWith(".astro"))
	.sort();

describe("astro-syntax conformance corpus (parser-level)", () => {
	if (fixtureFiles.length === 0) {
		throw new Error(`No fixtures found in ${FIXTURE_DIR}`);
	}
	for (const file of fixtureFiles) {
		const name = path.basename(file, ".astro");
		it(`${name}: parses without errors`, () => {
			const source = readFileSync(path.join(FIXTURE_DIR, file), "utf8");
			const { errors } = parseAstro(source);
			expect(errors).toEqual([]);
		});
	}
});
