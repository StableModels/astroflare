import { describe, expect, it } from "vitest";
import { buildCodeFrame, offsetToLocation, snippetFor } from "./code-frame.js";
import type { SnapshotErrorLocation } from "./types.js";

const SOURCE = ["---", "const x = 1;", "---", "<h1>{unclosed", "<p>after</p>", ""].join("\n");
// Offsets: `---\n` (0-3), `const x = 1;\n` (4-16), `---\n` (17-20),
// `<h1>{unclosed\n` (21-34: `<`@21, `h`@22, `1`@23, `>`@24, `{`@25, ..., `d`@33, `\n`@34),
// `<p>after</p>\n` (35-47).
const OPEN_BRACE_OFFSET = 25;
const UNCLOSED_END_OFFSET = 34; // exclusive — the `\n` after "unclosed".

describe("buildCodeFrame", () => {
	it("produces a line-numbered excerpt with a caret on the highlight line", () => {
		// `<h1>{unclosed` is line 4; the `{` is column 5.
		const location: SnapshotErrorLocation = {
			line: 4,
			column: 5,
			offset: OPEN_BRACE_OFFSET,
		};
		const frame = buildCodeFrame(SOURCE, location, { linesAround: 1 });
		if (!frame) throw new Error("expected a frame");
		// Three lines: line 3 (---), line 4 (<h1>{unclosed) with caret, line 5 (<p>after</p>).
		expect(frame.startLine).toBe(3);
		expect(frame.endLine).toBe(5);
		expect(frame.highlightLine).toBe(4);
		expect(frame.highlightColumn).toBe(5);
		const lines = frame.text.split("\n");
		// Caret line follows the highlighted line.
		expect(lines[0]).toBe("3 | ---");
		expect(lines[1]).toBe("4 | <h1>{unclosed");
		expect(lines[2]).toBe("  |     ^");
		expect(lines[3]).toBe("5 | <p>after</p>");
	});

	it("widens the caret to span end-column when end is set on the same line", () => {
		const location: SnapshotErrorLocation = {
			line: 4,
			column: 5,
			offset: OPEN_BRACE_OFFSET,
			end: { line: 4, column: 14, offset: UNCLOSED_END_OFFSET },
		};
		const frame = buildCodeFrame(SOURCE, location, { linesAround: 0 });
		if (!frame) throw new Error("expected a frame");
		expect(frame.highlightLength).toBe(9);
		const lines = frame.text.split("\n");
		expect(lines[1]).toBe("  |     ^^^^^^^^^");
	});

	it("returns null for out-of-range locations", () => {
		expect(buildCodeFrame("", { line: 1, column: 1, offset: 0 })).toBeNull();
		expect(buildCodeFrame(SOURCE, { line: 999, column: 1, offset: 0 })).toBeNull();
	});

	it("clamps to source bounds at the start and end", () => {
		const start = buildCodeFrame(SOURCE, { line: 1, column: 1, offset: 0 }, { linesAround: 5 });
		if (!start) throw new Error("expected a frame");
		expect(start.startLine).toBe(1);
		const end = buildCodeFrame(
			SOURCE,
			{ line: 6, column: 1, offset: SOURCE.length },
			{ linesAround: 5 },
		);
		// SOURCE has a trailing newline so split produces 6 lines.
		expect(end?.endLine).toBe(6);
	});
});

describe("snippetFor", () => {
	it("slices the offending span out of the source", () => {
		const snippet = snippetFor(SOURCE, {
			line: 4,
			column: 5,
			offset: OPEN_BRACE_OFFSET,
			end: { line: 4, column: 14, offset: UNCLOSED_END_OFFSET },
		});
		expect(snippet).toBe("{unclosed");
	});

	it("trims at the first newline so multi-line spans don't dump the file", () => {
		const snippet = snippetFor(SOURCE, {
			line: 4,
			column: 5,
			offset: OPEN_BRACE_OFFSET,
			end: { line: 5, column: 1, offset: SOURCE.length },
		});
		expect(snippet).toBe("{unclosed…");
	});

	it("returns null when end is missing (point locations carry no useful snippet)", () => {
		expect(snippetFor(SOURCE, { line: 4, column: 5, offset: OPEN_BRACE_OFFSET })).toBeNull();
	});

	it("truncates very long single-line spans", () => {
		const long = `${"a".repeat(500)}`;
		const out = snippetFor(long, {
			line: 1,
			column: 1,
			offset: 0,
			end: { line: 1, column: 501, offset: 500 },
		});
		expect(out?.length).toBe(201); // 200 chars + ellipsis
		expect(out?.endsWith("…")).toBe(true);
	});
});

describe("offsetToLocation", () => {
	it("computes 1-based line and column from a 0-based offset", () => {
		expect(offsetToLocation(SOURCE, 0)).toEqual({ line: 1, column: 1, offset: 0 });
		// Offset 4 (start of line 2) → line 2, col 1
		expect(offsetToLocation(SOURCE, 4)).toEqual({ line: 2, column: 1, offset: 4 });
		// Offset 25 (the `{` on line 4) → line 4, col 5
		const atBrace = offsetToLocation(SOURCE, OPEN_BRACE_OFFSET);
		expect(atBrace.line).toBe(4);
		expect(atBrace.column).toBe(5);
	});

	it("clamps offsets past end-of-source", () => {
		const loc = offsetToLocation("abc", 999);
		expect(loc.line).toBe(1);
		expect(loc.column).toBe(4);
	});
});
