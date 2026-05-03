/**
 * Unit tests for the tiny CSS scoper. The emitter feeds it CSS strings
 * pulled from `<style>` blocks; output is the same CSS with each
 * top-level selector decorated with `[data-aflare-h="<hash>"]`.
 */
import { describe, expect, it } from "vitest";
import { scopeCss, scopeSelectorList } from "./css-scope.js";

const ATTR = '[data-aflare-h="abcd1234"]';

describe("scopeSelectorList", () => {
	it("appends the attribute to a single tag selector", () => {
		expect(scopeSelectorList("p", ATTR)).toBe(`p${ATTR}`);
	});

	it("scopes each selector in a comma-separated list", () => {
		expect(scopeSelectorList("p, h1, .x", ATTR)).toBe(`p${ATTR}, h1${ATTR}, .x${ATTR}`);
	});

	it("does not split commas inside :is()/where()", () => {
		expect(scopeSelectorList(":is(h1, h2)", ATTR)).toBe(`:is(h1, h2)${ATTR}`);
	});

	it("inserts the attribute before pseudo-elements (`::before`)", () => {
		expect(scopeSelectorList("p::before", ATTR)).toBe(`p${ATTR}::before`);
	});

	it("appends after pseudo-classes (`:hover`)", () => {
		expect(scopeSelectorList("p:hover", ATTR)).toBe(`p:hover${ATTR}`);
	});

	it("preserves descendant combinators", () => {
		expect(scopeSelectorList(".foo .bar", ATTR)).toBe(`.foo .bar${ATTR}`);
	});

	it("leaves keyframe selectors alone", () => {
		expect(scopeSelectorList("from", ATTR)).toBe("from");
		expect(scopeSelectorList("0%", ATTR)).toBe("0%");
	});
});

describe("scopeCss", () => {
	it("scopes top-level rules", () => {
		const css = "p { color: red; } h1 { font-size: 2rem }";
		expect(scopeCss(css, ATTR)).toBe(`p${ATTR} { color: red; } h1${ATTR} { font-size: 2rem }`);
	});

	it("recurses into @media", () => {
		const css = "@media (min-width: 600px) { p { color: blue; } }";
		expect(scopeCss(css, ATTR)).toBe(`@media (min-width: 600px) { p${ATTR} { color: blue; } }`);
	});

	it("recurses into @supports", () => {
		const css = "@supports (display: grid) { .grid { display: grid; } }";
		expect(scopeCss(css, ATTR)).toBe(
			`@supports (display: grid) { .grid${ATTR} { display: grid; } }`,
		);
	});

	it("does NOT scope inside @keyframes", () => {
		const css =
			"@keyframes spin { from { transform: rotate(0); } to { transform: rotate(1turn); } }";
		expect(scopeCss(css, ATTR)).toBe(css);
	});

	it("passes statement-form @rules through unchanged", () => {
		const css = '@import "x.css";\n@charset "utf-8";';
		expect(scopeCss(css, ATTR)).toBe(css);
	});

	it("ignores commas inside string values", () => {
		const css = 'p[data-x="a, b"] { color: red; }';
		expect(scopeCss(css, ATTR)).toBe(`p[data-x="a, b"]${ATTR} { color: red; }`);
	});

	it("preserves CSS comments", () => {
		const css = "/* a comment */ p { color: red; }";
		expect(scopeCss(css, ATTR)).toBe(`/* a comment */ p${ATTR} { color: red; }`);
	});
});
