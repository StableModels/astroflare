/**
 * Structured compile failure used by the framework's build pipeline.
 *
 * The Astro/Markdown/MDX compilers all produce diagnostics that include
 * `{ message, start, end? }`. Historically each call site flattened the
 * first diagnostic into a string and threw a plain `Error`, losing the
 * structured location, the source text the diagnostic referenced, and any
 * sibling diagnostics. `buildSite({ continueOnError: true })` then bottled
 * that string into `SnapshotError.message` — leaving downstream tooling
 * (LLM agents, IDE overlays, CI annotators) to grep the line:column out of
 * the message instead of reading it programmatically.
 *
 * `CompileError` carries the original `filename`, the `source` text, and
 * every `AstroError` the compiler produced. Both `module-graph`
 * (workers-runtime build path) and the Node `build-site` throw this — the
 * outer `buildError()` helpers in `@astroflare/build` recognise it via
 * `instanceof CompileError` and unpack the structured fields onto the
 * `SnapshotError` they yield.
 *
 * Plain `Error`s still flow through the build pipeline (an OS-level read
 * failure, an `mdx: invalid YAML frontmatter` throw without a parser
 * range, etc.); they just yield a `SnapshotError` without `location` /
 * `diagnostics` populated.
 */
import type { AstroError } from "./astro/ast.js";

export interface CompileErrorInit {
	filename: string;
	source: string;
	diagnostics: readonly AstroError[];
	/**
	 * Optional override for the printable message. Defaults to the
	 * `compile error in <filename> at <line>:<column>: <first-message>`
	 * shape callers historically emitted, preserving the existing test
	 * regexes and CLI output.
	 */
	message?: string;
}

export class CompileError extends Error {
	override readonly name = "CompileError";
	readonly filename: string;
	readonly source: string;
	readonly diagnostics: readonly AstroError[];

	constructor(init: CompileErrorInit) {
		const first = init.diagnostics[0];
		const message =
			init.message ??
			(first
				? `compile error in ${init.filename} at ${first.start.line}:${first.start.column}: ${first.message}`
				: `compile error in ${init.filename}`);
		super(message);
		this.filename = init.filename;
		this.source = init.source;
		this.diagnostics = init.diagnostics;
	}
}

/** True if `err` is a CompileError (structural — survives realm boundaries). */
export function isCompileError(err: unknown): err is CompileError {
	if (err instanceof CompileError) return true;
	if (!err || typeof err !== "object") return false;
	const e = err as { name?: unknown; diagnostics?: unknown; source?: unknown; filename?: unknown };
	return (
		e.name === "CompileError" &&
		typeof e.filename === "string" &&
		typeof e.source === "string" &&
		Array.isArray(e.diagnostics)
	);
}
