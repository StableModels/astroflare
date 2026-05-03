/**
 * ESM `import` rewriter.
 *
 * Phase 4 uses this for two purposes:
 *   1. server-side bundling — rewrite `import X from "./Foo.astro"` to
 *      `import X from "./Foo.js"` so the executor's bundle (which holds
 *      compiled output at `<path>.js`) resolves the import.
 *   2. client-served modules at `/_aflare/mod?p=…&v=…` — rewrite imports to
 *      the same form so transitive fetches stay inside the preview server.
 *
 * Implementation: regex-based rewriting that handles the static-import forms
 * the compiler emits and the typical dynamic-import shapes user code uses.
 * For Phase 4 this is sufficient — the compiler's emitter is the only
 * deliberate emitter of `import` lines and we control its output. Edge cases
 * we deliberately don't cover (and document below):
 *   - imports inside string literals or comments — not handled, will be
 *     rewritten incorrectly. Mitigation: don't put `import "..."` inside a
 *     string in framework-emitted code. User code is parsed by the compiler
 *     before getting here.
 *   - nested `import.meta.resolve("…")` — not handled; same mitigation.
 *   - `import` on the LHS of a property access that happens to fit a pattern
 *     — not in any realistic shape.
 */

/**
 * Static import declarations:
 *
 *   import x from "..."
 *   import { a, b } from "..."
 *   import * as ns from "..."
 *   import "..."
 *   import type { T } from "..."
 *   export { x } from "..."
 *   export * from "..."
 *
 * The grouping in this regex is deliberate: capture group 1 is the bit before
 * the specifier, group 2 is the quote, group 3 is the specifier itself,
 * group 4 is the closing quote. Replacement keeps everything except group 3.
 */
const STATIC_IMPORT_RE =
	/((?:^|;|\n)\s*(?:import|export)(?:\s+type)?(?:\s+[\w*,{}\s]+\s+from)?\s+)(["'])([^"']+)(\2)/g;

/**
 * Dynamic imports: `import("...")`. Whitespace permitted around the parens.
 */
const DYNAMIC_IMPORT_RE = /(\bimport\s*\(\s*)(["'])([^"']+)(\2)/g;

export type RewriteFn = (specifier: string) => string;

export function rewriteImports(code: string, rewrite: RewriteFn): string {
	let out = code.replace(STATIC_IMPORT_RE, (_, head, q, spec, qe) => {
		const rewritten = rewrite(spec);
		return `${head}${q}${rewritten}${qe}`;
	});
	out = out.replace(DYNAMIC_IMPORT_RE, (_, head, q, spec, qe) => {
		const rewritten = rewrite(spec);
		return `${head}${q}${rewritten}${qe}`;
	});
	return out;
}

export function extractImports(code: string): string[] {
	const seen = new Set<string>();
	for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
		// Reset lastIndex because the same regex instance is reused above.
		re.lastIndex = 0;
		let match: RegExpExecArray | null = re.exec(code);
		while (match !== null) {
			seen.add(match[3] as string);
			match = re.exec(code);
		}
	}
	return Array.from(seen);
}
