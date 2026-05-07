/**
 * `.astro` compiler entrypoint.
 *
 * The single public surface for callers that want a one-shot
 * source → ESM compilation. Internally splits into parse → emit so
 * tests of either half can use them directly.
 *
 * TypeScript syntax in frontmatter is stripped via `transformTS`
 * (sucrase, pure-JS — see `../ts.ts`). The transform always runs;
 * JS-only frontmatter passes through unchanged at sub-ms cost. Same
 * code path runs in Node, workerd, and any other ES2022-capable
 * runtime — no WASM, no Node built-ins.
 */
import { contentId } from "@astroflare/core";
import type { AstroDocument, AstroError } from "./ast.js";
import { type EmitOptions, type EmitResult, emitDocument } from "./emitter.js";
import { parseAstro } from "./parser.js";
import { buildLineMap } from "./source-map.js";

export interface CompileOptions extends EmitOptions {
	/**
	 * Skip the TS-strip pass. Useful for parser-/emitter-only tests
	 * and for callers whose source is guaranteed to be plain JS.
	 * Default `false`.
	 */
	skipTsTransform?: boolean;
	/**
	 * `import.meta.env.<KEY>` substitutions, supplied from
	 * `AstroflareConfig.env`. The TS-strip pass replaces matching
	 * member accesses with the JSON-stringified value.
	 */
	env?: Record<string, unknown>;
}

export interface CompileResult extends EmitResult {
	doc: AstroDocument;
	errors: AstroError[];
}

/**
 * Compile a `.astro` source string. Async because the parser may
 * yield to async hooks; the TS-strip pass itself is synchronous
 * (sucrase). If you need a synchronous parse/emit for test
 * introspection, use `parseAstro` + `emitDocument` directly.
 */
export async function compileAstro(
	source: string,
	opts: CompileOptions = {},
): Promise<CompileResult> {
	const { doc, errors } = parseAstro(source);
	// Compute the per-component CSS scope hash up-front so the emitter can
	// stamp `data-aflare-h="<hash>"` onto every element + scope CSS rules.
	// 8 chars of content-addressed hash over the filename — Astro-style.
	const scopeHash = opts.scopeHash ?? (await contentId(opts.filename ?? source)).slice(0, 8);
	const emitted = emitDocument(doc, { ...opts, scopeHash });
	// The emitter doesn't see the original source, so attach it here so
	// devtools can show the right `.astro` content.
	const map =
		opts.filename && emitted.map ? buildLineMap(emitted.code, source, opts.filename) : emitted.map;
	if (opts.skipTsTransform) {
		return { ...emitted, map, doc, errors };
	}
	let code = emitted.code;
	try {
		const { transformTS } = await import("../ts.js");
		// `loader: "tsx"` enables sucrase's JSX transform alongside
		// TS-strip. The emitter dumps body expression source verbatim
		// into `$render`-template-literal interpolations; any JSX in
		// those expressions (`{items.map((x) => (<li>{x}</li>))}`) is
		// lowered to `$$jsx(...)` calls against the runtime ABI here,
		// not in a separate emit pass. Plain-JS expressions pass
		// through unchanged — sucrase's JSX transform is a no-op on
		// input that contains no JSX tokens.
		code = await transformTS(code, {
			filename: opts.filename,
			loader: "tsx",
			define: defineFromEnv(opts.env),
		});
	} catch (err) {
		// Surface as a compile error pinned to the source path. Callers
		// (notably `module-graph.#compileSource`) translate this into a
		// thrown `compile error in <path> ...` — a clean, named failure
		// instead of an opaque downstream V8 syntax error.
		const message = err instanceof Error ? err.message : String(err);
		errors.push({
			message: `TypeScript transform failed${opts.filename ? ` in ${opts.filename}` : ""}: ${message}`,
			start: { line: 1, column: 1, offset: 0 },
		});
	}
	return { ...emitted, code, map, doc, errors };
}

/**
 * Translate `AstroflareConfig.env` into the `define` shape consumed by
 * `transformTS`. Each key becomes `import.meta.env.<KEY>` mapped to a
 * JSON-stringified value; the TS-strip pass replaces matching member
 * accesses inline.
 */
function defineFromEnv(
	env: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
	if (!env) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		out[`import.meta.env.${k}`] = JSON.stringify(v);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export * from "./ast.js";
export * from "./parser.js";
export * from "./emitter.js";
export { CompileError, isCompileError, type CompileErrorInit } from "../compile-error.js";
