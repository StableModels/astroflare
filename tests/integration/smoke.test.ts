import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("integration harness smoke", () => {
	it("boots a workerd instance", async () => {
		const res = await SELF.fetch("https://example.com/");
		expect(res.status).toBe(200);
		expect(await res.text()).toMatch(/Phase 0 placeholder/);
	});
});
