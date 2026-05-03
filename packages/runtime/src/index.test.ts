import { describe, expect, it } from "vitest";
import { RUNTIME_VERSION } from "./index.js";

describe("@astroflare/runtime placeholder", () => {
	it("exports a version constant", () => {
		expect(RUNTIME_VERSION).toBe("0.0.0");
	});
});
