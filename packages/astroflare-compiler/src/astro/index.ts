/**
 * `.astro` compiler entrypoint.
 *
 * The single public surface for callers that want a one-shot
 * source → ESM compilation. Internally splits into parse → emit so
 * tests of either half can use them directly.
 */
import type { AstroDocument, AstroError } from "./ast.js";
import { type EmitOptions, type EmitResult, emitDocument } from "./emitter.js";
import { parseAstro } from "./parser.js";

export interface CompileOptions extends EmitOptions {}

export interface CompileResult extends EmitResult {
	doc: AstroDocument;
	errors: AstroError[];
}

export function compileAstro(source: string, opts: CompileOptions = {}): CompileResult {
	const { doc, errors } = parseAstro(source);
	const result = emitDocument(doc, opts);
	return { ...result, doc, errors };
}

export * from "./ast.js";
export * from "./parser.js";
export * from "./emitter.js";
