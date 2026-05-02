import { describe, expect, it } from "vitest";
import { PREVIEW_VERSION } from "./index.js";

describe("@astroflare/preview placeholder", () => {
	it("exports a version constant", () => {
		expect(PREVIEW_VERSION).toBe("0.0.0");
	});
});
