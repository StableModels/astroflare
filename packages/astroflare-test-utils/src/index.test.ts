import { describe, expect, it } from "vitest";
import { TEST_UTILS_VERSION } from "./index.js";

describe("@astroflare/test-utils placeholder", () => {
	it("exports a version constant", () => {
		expect(TEST_UTILS_VERSION).toBe("0.0.0");
	});
});
