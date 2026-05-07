import { describe, expect, it } from "vitest";
import type { AstroError } from "./astro/ast.js";
import { CompileError, isCompileError } from "./compile-error.js";

const DIAG: AstroError = {
	message: "Unclosed expression (missing `}`)",
	start: { line: 4, column: 5, offset: 22 },
};

describe("CompileError", () => {
	it("formats a default message from the first diagnostic", () => {
		const err = new CompileError({
			filename: "/src/pages/bad.astro",
			source: "<p>{unclosed",
			diagnostics: [DIAG],
		});
		expect(err.name).toBe("CompileError");
		expect(err.message).toBe(
			"compile error in /src/pages/bad.astro at 4:5: Unclosed expression (missing `}`)",
		);
		expect(err.filename).toBe("/src/pages/bad.astro");
		expect(err.source).toBe("<p>{unclosed");
		expect(err.diagnostics).toHaveLength(1);
	});

	it("falls back to a filename-only message when no diagnostics are supplied", () => {
		const err = new CompileError({
			filename: "/src/pages/empty.astro",
			source: "",
			diagnostics: [],
		});
		expect(err.message).toBe("compile error in /src/pages/empty.astro");
	});

	it("respects an explicit message override", () => {
		const err = new CompileError({
			filename: "/src/pages/bad.astro",
			source: "<p>{unclosed",
			diagnostics: [DIAG],
			message: "custom: parse failure",
		});
		expect(err.message).toBe("custom: parse failure");
	});

	it("isCompileError matches by class", () => {
		const err = new CompileError({
			filename: "/x.astro",
			source: "",
			diagnostics: [],
		});
		expect(isCompileError(err)).toBe(true);
		expect(isCompileError(new Error("x"))).toBe(false);
	});

	it("isCompileError matches by structural shape (name + filename + source + diagnostics)", () => {
		// Realm-crossing case: a CompileError reconstructed on the other side
		// of a `structuredClone` boundary loses its prototype but keeps the
		// name + own properties. The duck-type guard recognises it.
		const duck = {
			name: "CompileError",
			message: "compile error in /x.astro",
			filename: "/x.astro",
			source: "",
			diagnostics: [],
		};
		expect(isCompileError(duck)).toBe(true);
	});

	it("isCompileError rejects non-Errors and unrelated shapes", () => {
		expect(isCompileError(undefined)).toBe(false);
		expect(isCompileError(null)).toBe(false);
		expect(isCompileError("string")).toBe(false);
		expect(isCompileError({ name: "CompileError" })).toBe(false); // missing filename/source/diagnostics
	});
});
