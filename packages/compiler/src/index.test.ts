import { describe, expect, it } from "vitest";
import { COMPILER_VERSION } from "./index.js";

describe("@astroflare/compiler placeholder", () => {
	it("exports a version constant", () => {
		expect(COMPILER_VERSION).toBe("0.0.0");
	});
});
