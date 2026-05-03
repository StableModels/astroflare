import { describe, expect, it } from "vitest";
import { HOST_CLOUDFLARE_VERSION } from "./index.js";

describe("@astroflare/host-cloudflare placeholder (workerd)", () => {
	it("exports a version constant", () => {
		expect(HOST_CLOUDFLARE_VERSION).toBe("0.0.0");
	});

	it("runs inside workerd (has Cloudflare globals)", () => {
		// vitest-pool-workers gives us workerd's runtime; structuredClone & WebSocketPair
		// exist there but not in plain Node. This proves the pool is wired correctly.
		expect(typeof structuredClone).toBe("function");
		expect(typeof WebSocketPair).toBe("function");
	});
});
