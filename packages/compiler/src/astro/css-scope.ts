/**
 * Tiny CSS scoper. Rewrites every selector in `css` so it only matches
 * elements bearing `[data-aflare-h="<hash>"]`. The emitter attaches that
 * attribute to every element rendered by the same `.astro` component,
 * giving us per-component CSS scoping with zero runtime cost.
 *
 * Phase 12 carve-outs:
 *   - No nested CSS (Astro supports `&` parent-ref through PostCSS;
 *     we don't yet ship a PostCSS pass).
 *   - `@scope`, `@layer` etc. nested selectors aren't recursively
 *     rewritten beyond the simple `@media` / `@supports` case.
 *   - Single-colon legacy pseudo-elements (`:before`, `:after`,
 *     `:first-line`, `:first-letter`) are scoped at the wrong position
 *     because we only special-case `::` (double-colon). Authors should
 *     prefer the modern `::` form.
 *   - `@keyframes` selectors (`from`, `to`, `0%`, `100%`) are passed
 *     through unchanged.
 */

const KEYFRAME_SELECTOR_RE = /^(from|to|\d+(?:\.\d+)?%)$/i;
const SCOPE_SKIP_AT_RULES = new Set([
	"@charset",
	"@import",
	"@namespace",
	"@font-face",
	"@page",
	"@property",
	"@keyframes",
]);

/**
 * Apply scoping to a CSS source. `attrSelector` is the bracketed
 * attribute selector to graft onto each compound selector, e.g.
 * `[data-aflare-h="abcd1234"]`.
 */
export function scopeCss(css: string, attrSelector: string): string {
	const out: string[] = [];
	scopeBlock(css, attrSelector, out);
	return out.join("");
}

/**
 * Walk a CSS block (or top-level), rewriting selectors. Recurses into
 * `@media` / `@supports` style rules; passes through `@keyframes` etc.
 * unchanged.
 */
function scopeBlock(css: string, attrSelector: string, out: string[]): void {
	let i = 0;
	while (i < css.length) {
		// Whitespace + comments — copy through.
		const wsEnd = consumeWhitespaceAndComments(css, i, out);
		if (wsEnd > i) {
			i = wsEnd;
			continue;
		}
		if (i >= css.length) break;

		const ch = css[i];

		if (ch === "}") {
			// Stray closing brace at this level — emit and stop. Caller will
			// resume.
			out.push("}");
			i++;
			continue;
		}

		if (ch === "@") {
			// At-rule. Find its prelude (everything up to `;` or `{` at depth 0,
			// honouring strings).
			const preludeEnd = findAtRulePreludeEnd(css, i);
			const prelude = css.slice(i, preludeEnd);
			const atName = prelude.match(/^@[\w-]+/)?.[0]?.toLowerCase() ?? "";
			if (css[preludeEnd] === ";" || preludeEnd === css.length) {
				// Statement-form at-rule — copy through.
				out.push(prelude);
				if (css[preludeEnd] === ";") {
					out.push(";");
					i = preludeEnd + 1;
				} else {
					i = preludeEnd;
				}
				continue;
			}
			// Block-form at-rule. Slice the body.
			const bodyEnd = findMatchingBrace(css, preludeEnd);
			const body = css.slice(preludeEnd + 1, bodyEnd);
			out.push(prelude, "{");
			if (SCOPE_SKIP_AT_RULES.has(atName)) {
				out.push(body);
			} else {
				scopeBlock(body, attrSelector, out);
			}
			out.push("}");
			i = bodyEnd + 1;
			continue;
		}

		// Regular rule: selector list `{ body }`.
		const selectorEnd = findRuleSelectorEnd(css, i);
		if (selectorEnd === css.length || css[selectorEnd] !== "{") {
			// No body — malformed CSS; copy rest through and bail.
			out.push(css.slice(i));
			return;
		}
		const selectorList = css.slice(i, selectorEnd);
		const bodyEnd = findMatchingBrace(css, selectorEnd);
		const body = css.slice(selectorEnd + 1, bodyEnd);
		out.push(scopeSelectorList(selectorList, attrSelector));
		out.push("{");
		// Body is plain declarations — pass through.
		out.push(body);
		out.push("}");
		i = bodyEnd + 1;
	}
}

function consumeWhitespaceAndComments(css: string, start: number, out: string[]): number {
	let i = start;
	while (i < css.length) {
		const ch = css[i];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			out.push(ch);
			i++;
			continue;
		}
		if (ch === "/" && css[i + 1] === "*") {
			const end = css.indexOf("*/", i + 2);
			const stop = end < 0 ? css.length : end + 2;
			out.push(css.slice(i, stop));
			i = stop;
			continue;
		}
		break;
	}
	return i;
}

function findAtRulePreludeEnd(css: string, start: number): number {
	let i = start;
	while (i < css.length) {
		const ch = css[i];
		if (ch === '"' || ch === "'") {
			i = skipString(css, i, ch);
			continue;
		}
		if (ch === "(") {
			i = skipParen(css, i);
			continue;
		}
		if (ch === ";" || ch === "{") return i;
		i++;
	}
	return css.length;
}

function findRuleSelectorEnd(css: string, start: number): number {
	let i = start;
	while (i < css.length) {
		const ch = css[i];
		if (ch === '"' || ch === "'") {
			i = skipString(css, i, ch);
			continue;
		}
		if (ch === "(") {
			i = skipParen(css, i);
			continue;
		}
		if (ch === "{" || ch === "}") return i;
		i++;
	}
	return css.length;
}

function findMatchingBrace(css: string, start: number): number {
	// `start` points at `{`.
	let depth = 0;
	let i = start;
	while (i < css.length) {
		const ch = css[i];
		if (ch === '"' || ch === "'") {
			i = skipString(css, i, ch);
			continue;
		}
		if (ch === "/" && css[i + 1] === "*") {
			const end = css.indexOf("*/", i + 2);
			i = end < 0 ? css.length : end + 2;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
		i++;
	}
	return css.length;
}

function skipString(css: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < css.length) {
		const ch = css[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === quote) return i + 1;
		i++;
	}
	return css.length;
}

function skipParen(css: string, start: number): number {
	let depth = 0;
	let i = start;
	while (i < css.length) {
		const ch = css[i];
		if (ch === '"' || ch === "'") {
			i = skipString(css, i, ch);
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i + 1;
		}
		i++;
	}
	return css.length;
}

/**
 * Split a selector list on top-level commas (commas inside `:is(a, b)`
 * etc. don't split) and scope each.
 */
export function scopeSelectorList(list: string, attrSelector: string): string {
	const parts: string[] = [];
	const splits = splitSelectors(list);
	for (const sel of splits) {
		parts.push(scopeOneSelector(sel, attrSelector));
	}
	return parts.join(",");
}

function splitSelectors(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < list.length; i++) {
		const ch = list[i];
		if (ch === '"' || ch === "'") {
			i = skipString(list, i, ch) - 1;
			continue;
		}
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth--;
		else if (ch === "," && depth === 0) {
			out.push(list.slice(start, i));
			start = i + 1;
		}
	}
	out.push(list.slice(start));
	return out;
}

function scopeOneSelector(sel: string, attrSelector: string): string {
	const trimmed = sel.trim();
	if (!trimmed) return sel;
	if (KEYFRAME_SELECTOR_RE.test(trimmed)) return sel;
	const lead = sel.slice(0, sel.length - sel.trimStart().length);
	const trailWsLen = sel.length - sel.trimEnd().length;
	const trail = trailWsLen === 0 ? "" : sel.slice(sel.length - trailWsLen);

	// Insert the attribute selector before any trailing pseudo-element.
	// Pseudo-elements must be the rightmost component of a selector, so
	// `p::before[h]` is INVALID — `p[h]::before` is correct.
	const pseudoElementMatch = trimmed.match(/(::[\w-]+(?:\([^)]*\))?\s*)$/);
	if (pseudoElementMatch) {
		const pseudo = pseudoElementMatch[0];
		const before = trimmed.slice(0, trimmed.length - pseudo.length);
		return `${lead}${before}${attrSelector}${pseudo}${trail}`;
	}
	return `${lead}${trimmed}${attrSelector}${trail}`;
}
