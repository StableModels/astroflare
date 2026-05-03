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
import { transformTS } from "../ts.js";
import type { AstroDocument, AstroError } from "./ast.js";
import { type EmitOptions, type EmitResult, emitDocument } from "./emitter.js";
import { parseAstro } from "./parser.js";

export interface CompileOptions extends EmitOptions {
	/**
	 * Skip the TS-strip pass. Useful for tests that exercise the parser
	 * + emitter only and don't want to wait on esbuild-wasm init. Default
	 * `false`. Production code should leave this off.
	 */
	skipTsTransform?: boolean;
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
	const emitted = emitDocument(doc, opts);
	if (opts.skipTsTransform) {
		return { ...emitted, doc, errors };
	}
	let code = emitted.code;
	try {
		code = await transformTS(code, { filename: opts.filename });
	} catch (err) {
		const message = (err as Error).message ?? String(err);
		if (isEsbuildEnvironmentError(message)) {
			// The runtime environment can't initialise esbuild-wasm (typically
			// workerd in a test, where the WASM blob isn't bound). Skip the
			// strip pass — module sources are JS-only in that environment by
			// convention, and the inline bundler tolerates the un-stripped
			// emitter output.
			return { ...emitted, code, doc, errors };
		}
		// Genuine syntax / type error in user code: record and fall back to
		// the pre-transform code so callers can still display something.
		errors.push({
			message: `TypeScript transform failed: ${message}`,
			start: { line: 1, column: 1, offset: 0 },
		});
	}
	return { ...emitted, code, doc, errors };
}

/**
 * Distinguish "esbuild-wasm could not initialise in this environment"
 * (a host-config issue, recoverable: skip the transform) from a real
 * syntax error in user code (must surface to the caller).
 */
function isEsbuildEnvironmentError(message: string): boolean {
	return /wasmURL|wasmModule|initialize|fetch.*esbuild/i.test(message);
}

export * from "./ast.js";
export * from "./parser.js";
export * from "./emitter.js";
