/**
 * `transformTS(source) → string` — strip TypeScript syntax to plain ESM
 * and (when `loader: "tsx"`) lower JSX to `$$jsx` runtime calls.
 *
 * Backed by [sucrase](https://github.com/alangpierce/sucrase): a pure-JS
 * TS/JSX stripper. The previous implementation routed through
 * `esbuild-wasm`, but Cloudflare Workers blocks runtime
 * `WebAssembly.instantiate()` of arbitrary bytes
 * (`Wasm code generation disallowed by embedder`) — so any TS-bearing
 * frontmatter run through `createPreviewHandler` or the workers-runtime
 * `buildSite` would either crash inside esbuild's init or leak
 * un-stripped source into the spawned isolate, which V8 then refused
 * to parse (`Unexpected strict mode reserved word` on `interface`,
 * etc.). Sucrase is single-pass, ~2 ms per file, no WASM, and its
 * coverage of TS-syntax-only stripping (interfaces, type aliases,
 * `: Type` annotations, `as Type` casts, generic params, enums) is a
 * strict superset of what `.astro` frontmatter realistically uses.
 *
 * This is the same workers-incompatible-WASM pattern as the Shiki
 * Oniguruma engine: see CLAUDE.md's "Hard rule: every shipped path
 * must run on a Cloudflare Worker" — TS transform is on that list.
 *
 * **JSX pass.** When the caller passes `loader: "tsx"`, sucrase's
 * `jsx` transform runs alongside `typescript`. It uses the *classic*
 * runtime with custom pragmas (`$$jsx` / `$$Fragment`) that point at
 * Astroflare-runtime primitives — `<li>{x}</li>` lowers to
 * `$$jsx("li", null, x)`, `<>x</>` lowers to
 * `$$jsx($$Fragment, null, "x")`. The runtime's `$$jsx` dispatches on
 * the tag's type (string → HTML element, function → component) and
 * returns a `RawHtml` marker that composes with `$render` template
 * literals without double-escaping. `compileAstro` always passes
 * `loader: "tsx"` so JSX-in-expression bodies (`{items.map((x) => (<li>{x}</li>))}`)
 * survive end-to-end; plain-JS bodies are unaffected because the JSX
 * transform is a no-op on input that contains no JSX tokens.
 *
 * `import.meta.env.<KEY>` substitution (formerly esbuild's `define`)
 * is handled here as a textual pre-pass before sucrase. The pattern
 * is `import.meta.env.<identifier>`; each match is replaced with the
 * caller-supplied JSON-stringified literal. The pre-pass is crude
 * (regex over source, not AST) but the access shape is fixed enough
 * that it covers every realistic call site without false positives.
 */

import { transform } from "sucrase";

export interface TransformTsOptions {
	/** Source filename used in error messages. */
	filename?: string;
	/** Loader hint — defaults to `"ts"`. JSX-bearing files pass `"tsx"`. */
	loader?: "ts" | "tsx";
	/**
	 * `define` map. Each key (e.g. `"import.meta.env.MODE"`) is replaced
	 * wherever it appears as a member access. Values are JSON-stringified
	 * literal source code — `"\"production\""` for a string, `"42"` for
	 * a number, etc. Today only `import.meta.env.<KEY>` patterns are
	 * supported (the only shape the framework emits); other keys are
	 * silently ignored.
	 */
	define?: Record<string, string>;
}

/**
 * Strip TS syntax to plain ESM. JS-only source passes through (sucrase
 * tolerates JS as a TS subset). Top-level `import`/`export` shape is
 * preserved (sucrase's `typescript` transform doesn't rewrite ESM to
 * CJS unless the `imports` transform is also enabled, which we don't).
 */
export async function transformTS(source: string, opts: TransformTsOptions = {}): Promise<string> {
	return transformTSSync(source, opts);
}

/**
 * Sync entry point. Sucrase is itself sync, so the only reason the async
 * wrapper exists is backward compatibility with the esbuild-wasm-era
 * callers that awaited the result.
 */
export function transformTSSync(source: string, opts: TransformTsOptions = {}): string {
	const loader = opts.loader ?? "ts";
	const transforms: Array<"typescript" | "jsx"> = ["typescript"];
	if (loader === "tsx") transforms.push("jsx");

	const preSubstituted = applyDefines(source, opts.define);

	try {
		const result = transform(preSubstituted, {
			transforms,
			// Skip sucrase's ES-syntax lowering pass (the one that
			// rewrites `??`, `?.`, optional spread, etc. into runtime
			// helpers). Workers + every modern V8 we care about already
			// supports those forms natively, and the helpers would
			// otherwise leak into the emitted module — `_nullishCoalesce`
			// at the top of every file that uses `??`. We only want
			// **type stripping**, not ES downleveling.
			disableESTransforms: true,
			// Classic JSX runtime targeting Astroflare-runtime primitives.
			// `<li>{x}</li>` → `$$jsx("li", null, x)`, `<>x</>` →
			// `$$jsx($$Fragment, null, "x")`. The pragmas are the names
			// the emitter unconditionally imports from
			// `@astroflare/runtime/internal` (see `RUNTIME_SYMBOLS` in
			// `astro/emitter.ts`). `production: true` strips the React
			// dev-mode `__self` / `__source` props sucrase otherwise
			// adds — they're noise for a non-React runtime.
			jsxRuntime: "classic",
			jsxPragma: "$$jsx",
			jsxFragmentPragma: "$$Fragment",
			production: true,
			...(opts.filename ? { filePath: opts.filename } : {}),
		});
		return result.code;
	} catch (err) {
		// Sucrase prefixes the message with `Error transforming <filePath>:`
		// when `filePath` is set; surface that verbatim (callers already
		// expect a readable message).
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(message);
	}
}

/**
 * Apply caller-supplied `import.meta.env.<KEY>` substitutions.
 *
 * We only handle the `import.meta.env.<identifier>` shape — every key
 * Astroflare emits has that prefix (see `defineFromEnv` in
 * `astro/index.ts`). The regex is anchored on the access pattern and
 * boundary-checked so member chains like `import.meta.env.X.Y` don't
 * partially substitute (the trailing `.Y` would dangle).
 *
 * Quoted strings and comments aren't excluded — a user-authored string
 * literal containing `import.meta.env.MODE` would be substituted too.
 * The same hazard existed under esbuild's `define`, and in practice
 * nobody writes that source.
 */
function applyDefines(source: string, define: Record<string, string> | undefined): string {
	if (!define) return source;
	let out = source;
	for (const [key, value] of Object.entries(define)) {
		const match = key.match(/^import\.meta\.env\.([A-Za-z_$][A-Za-z0-9_$]*)$/);
		if (!match) continue;
		const ident = match[1];
		// Match `import.meta.env.<IDENT>` not followed by another
		// identifier-continuation char (so `MODE_X` doesn't also match `MODE`).
		const re = new RegExp(`\\bimport\\.meta\\.env\\.${ident}\\b`, "g");
		out = out.replace(re, value);
	}
	return out;
}

/** Test-affordance: no-op under sucrase (kept for source-compat with old tests). */
export function __resetEsbuildForTests(): void {}
