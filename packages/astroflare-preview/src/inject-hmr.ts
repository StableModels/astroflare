/**
 * Inject the HMR client `<script type="module">…</script>` block into HTML
 * responses.
 *
 * Insertion order of preference:
 *   1. immediately before `</head>`  (preferred — runs before body parsing)
 *   2. immediately before `</body>`  (fallback)
 *   3. appended to the document      (last resort, e.g. fragment-only routes)
 *
 * The injected script is `type="module"` so module-level `const` and `import`
 * (when we add them in Phase 8) don't pollute the global scope.
 *
 * Tag matching is case-insensitive — Astro/Astroflare templates can use
 * `<HEAD>` or `<head>` either way. Search for the *last* occurrence of each
 * closing tag so we don't get fooled by literal `</head>` text inside, e.g.,
 * a `<pre>` block (defensive — unlikely in practice).
 */

const HEAD_CLOSE = /<\/head>/i;
const BODY_CLOSE = /<\/body>/i;

export function injectHmrScript(html: string, scriptSource: string): string {
	const tag = `<script type="module">${scriptSource}</script>`;

	const headMatch = lastMatch(html, HEAD_CLOSE);
	if (headMatch !== null) {
		return html.slice(0, headMatch) + tag + html.slice(headMatch);
	}

	const bodyMatch = lastMatch(html, BODY_CLOSE);
	if (bodyMatch !== null) {
		return html.slice(0, bodyMatch) + tag + html.slice(bodyMatch);
	}

	return html + tag;
}

/** Index of the last regex match's start, or null if no match. */
function lastMatch(s: string, re: RegExp): number | null {
	let last: number | null = null;
	const g = new RegExp(re.source, `${re.flags}${re.flags.includes("g") ? "" : "g"}`);
	let m: RegExpExecArray | null = g.exec(s);
	while (m !== null) {
		last = m.index;
		m = g.exec(s);
	}
	return last;
}
