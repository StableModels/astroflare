/**
 * Pure-JS code-frame helper used by build error reporting.
 *
 * Given a source string and a location, returns a multi-line excerpt of the
 * surrounding source with line numbers and a caret pointer at the offending
 * column — the same shape `babel-code-frame` and `tsc` print, written from
 * scratch so we don't take a dependency that pulls in `chalk`/`node:*`.
 *
 * Workers-runnable: only standard string/number ops, no Node built-ins, no
 * regex packages. Both build entrypoints (`@astroflare/build/node` and
 * `@astroflare/build` workers) share this helper so the diagnostic shape is
 * identical regardless of which lifecycle produced the error.
 *
 * Operates over the `SnapshotErrorLocation` / `SnapshotErrorCodeFrame`
 * shapes from `./types.js` so the helper output drops straight into a
 * `SnapshotError` field with no shape conversion.
 */
import type { SnapshotErrorCodeFrame, SnapshotErrorLocation } from "./types.js";

export interface BuildCodeFrameOptions {
	/**
	 * Lines of context to show before and after the highlighted line.
	 * Defaults to `2`, producing a 5-line frame for a single-line error.
	 */
	linesAround?: number;
}

/**
 * Build a printable code frame for `location` inside `source`.
 *
 * Returns `null` when the location falls outside the source (defensive — a
 * stale offset shouldn't crash diagnostics formatting).
 */
export function buildCodeFrame(
	source: string,
	location: SnapshotErrorLocation,
	opts: BuildCodeFrameOptions = {},
): SnapshotErrorCodeFrame | null {
	if (!source) return null;
	const linesAround = opts.linesAround ?? 2;
	const lines = source.split("\n");
	const totalLines = lines.length;
	if (location.line < 1 || location.line > totalLines) return null;

	const startLine = Math.max(1, location.line - linesAround);
	const endLine = Math.min(totalLines, location.line + linesAround);

	const gutterWidth = String(endLine).length;
	const out: string[] = [];
	for (let n = startLine; n <= endLine; n++) {
		const text = lines[n - 1] ?? "";
		const prefix = `${String(n).padStart(gutterWidth, " ")} | `;
		out.push(prefix + text);
		if (n === location.line) {
			const caretLength = caretLengthFor(location, text);
			const caretCol = Math.max(1, Math.min(location.column, text.length + 1));
			const pad = `${" ".repeat(gutterWidth)} | ${" ".repeat(caretCol - 1)}`;
			out.push(pad + "^".repeat(Math.max(1, caretLength)));
		}
	}
	return {
		text: out.join("\n"),
		startLine,
		endLine,
		highlightLine: location.line,
		highlightColumn: location.column,
		highlightLength: caretLengthFor(location, lines[location.line - 1] ?? ""),
	};
}

function caretLengthFor(location: SnapshotErrorLocation, line: string): number {
	if (!location.end) return 1;
	if (location.end.line !== location.line) {
		// Multi-line span: underline from the column to end-of-line.
		const remaining = line.length - (location.column - 1);
		return Math.max(1, remaining);
	}
	const span = location.end.column - location.column;
	return span > 0 ? span : 1;
}

/**
 * Slice the offending source span out of `source` for a given location.
 * Returns `null` when the parser didn't supply an `end` (a point location
 * isn't useful as a snippet — the code frame still pinpoints it).
 *
 * Trims at the first newline so a multi-line span doesn't dump half the
 * file into the snippet field; consumers that need the full span can
 * always reconstruct it from `source.slice(location.offset, location.end.offset)`.
 */
export function snippetFor(
	source: string,
	location: SnapshotErrorLocation,
	maxLength = 200,
): string | null {
	if (!location.end) return null;
	const start = Math.max(0, location.offset);
	const end = Math.min(source.length, location.end.offset);
	if (end <= start) return null;
	const raw = source.slice(start, end);
	const firstNl = raw.indexOf("\n");
	const oneLine = firstNl === -1 ? raw : `${raw.slice(0, firstNl)}…`;
	if (oneLine.length <= maxLength) return oneLine;
	return `${oneLine.slice(0, maxLength)}…`;
}

/**
 * Convert a 0-based byte offset into a 1-based `{line, column}`.
 * Useful for callers that have an offset but no pre-computed line/col
 * (e.g. acorn's `pos`-only errors).
 */
export function offsetToLocation(source: string, offset: number): SnapshotErrorLocation {
	let line = 1;
	let column = 1;
	const max = Math.min(offset, source.length);
	for (let i = 0; i < max; i++) {
		if (source.charCodeAt(i) === 10 /* \n */) {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
	}
	return { offset, line, column };
}
