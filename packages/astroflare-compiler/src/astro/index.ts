/**
 * `.astro` compiler entrypoint.
 *
 * The single public surface for callers that want a one-shot
 * source → ESM compilation. Internally splits into parse → emit so
 * tests of either half can use them directly.
 *
 * Phase 11: TypeScript syntax in frontmatter is stripped via
 * `transformTS` (esbuild-wasm). The transform always runs — TS is a
 * superset of JS, so JS-only frontmatter passes through unchanged at
 * a sub-ms per-call cost after esbuild-wasm's one-time init.
 */
import { contentId } from "@astroflare/core";
import type { AstroDocument, AstroError } from "./ast.js";
import { type EmitOptions, type EmitResult, emitDocument } from "./emitter.js";
import { parseAstro } from "./parser.js";
import { buildLineMap } from "./source-map.js";

// `transformTS` lazily imported in the compile path so callers that
// pass `skipTsTransform: true` (e.g. the preview worker on
// Cloudflare, where the bundle size budget can't accommodate
// esbuild-wasm) never load esbuild. Static-import users still see
// the same eager-load behaviour because the import below resolves
// at first call.

export interface CompileOptions extends EmitOptions {
	/**
	 * Skip the TS-strip pass. Useful for tests that exercise the parser
	 * + emitter only and don't want to wait on esbuild-wasm init. Default
	 * `false`. Production code should leave this off.
	 */
	skipTsTransform?: boolean;
	/**
	 * `import.meta.env.<KEY>` substitutions, supplied from
	 * `AstroflareConfig.env`. esbuild's `define` rewrites the accesses at
	 * the TS-strip pass.
	 */
	env?: Record<string, unknown>;
}

export interface CompileResult extends EmitResult {
	doc: AstroDocument;
	errors: AstroError[];
}

/**
 * Compile a `.astro` source string. Async because the TS-strip pass
 * goes through esbuild-wasm. If you need a synchronous parse/emit for
 * test introspection, use `parseAstro` + `emitDocument` directly.
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
		// Dynamic import — keeps esbuild-wasm out of bundles whose
		// callers always pass `skipTsTransform: true`.
		const { transformTS } = await import("../ts.js");
		code = await transformTS(code, {
			filename: opts.filename,
			define: defineFromEnv(opts.env),
		});
	} catch (err) {
		const message = (err as Error).message ?? String(err);
		if (isEsbuildEnvironmentError(message)) {
			// The runtime environment can't initialise esbuild-wasm (typically
			// workerd in a test, where the WASM blob isn't bound). Skip the
			// strip pass — module sources are JS-only in that environment by
			// convention, and the inline bundler tolerates the un-stripped
			// emitter output.
			return { ...emitted, code, map, doc, errors };
		}
		// Genuine syntax / type error in user code: record and fall back to
		// the pre-transform code so callers can still display something.
		errors.push({
			message: `TypeScript transform failed: ${message}`,
			start: { line: 1, column: 1, offset: 0 },
		});
	}
	return { ...emitted, code, map, doc, errors };
}

/**
 * Distinguish "esbuild-wasm could not initialise in this environment"
 * (a host-config issue, recoverable: skip the transform) from a real
 * syntax error in user code (must surface to the caller).
 */
function isEsbuildEnvironmentError(message: string): boolean {
	return /wasmURL|wasmModule|initialize|fetch.*esbuild/i.test(message);
}

/**
 * Translate `AstroflareConfig.env` into esbuild's `define` shape. Each
 * key becomes `import.meta.env.KEY` mapped to the JSON-stringified
 * value. esbuild substitutes the access at the TS-strip pass.
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
