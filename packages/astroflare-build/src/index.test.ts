import { describe, expect, it } from "vitest";
import { BUILD_VERSION } from "./index.js";

describe("@astroflare/build placeholder", () => {
	it("exports a version constant", () => {
		expect(BUILD_VERSION).toBe("0.0.0");
	});
});
