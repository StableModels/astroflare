import type { AstroDocument } from "./astro/ast.js";
import { type EmitOptions, type EmitResult, emit } from "./astro/emit.js";
import { AstroParseError } from "./astro/errors.js";
import { parseAstro } from "./astro/parser.js";

export const COMPILER_VERSION = "0.1.0";

export interface CompileAstroOptions extends EmitOptions {}

export interface CompileAstroResult extends EmitResult {
  ast: AstroDocument;
}

/**
 * Parse and emit a single `.astro` source file.
 *
 * The resulting `code` is an ES module whose default export is a render
 * function `(result, props, slots) => Promise<string>`. See
 * `@astroflare/runtime` for the shape of `result`.
 */
export function compileAstro(
  source: string,
  options: CompileAstroOptions = {},
): CompileAstroResult {
  const ast = parseAstro(source);
  const { code } = emit(ast, options);
  return { ast, code };
}

export { parseAstro } from "./astro/parser.js";
export { emit } from "./astro/emit.js";
export { AstroParseError } from "./astro/errors.js";
export type {
  AstroDocument,
  AstroNode,
  AstroAttribute,
  Frontmatter,
  SourceRange,
} from "./astro/ast.js";
export type { EmitOptions, EmitResult } from "./astro/emit.js";
export type { SourcePosition } from "./astro/errors.js";
