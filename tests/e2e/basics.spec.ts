/**
 * Phase 22 e2e — `basics` fixture.
 *
 * Verifies routing across multiple pages, scoped CSS attribution
 * (`data-aflare-h`), and frontmatter expression interpolation all
 * round-trip through the framework's compile + render onto the
 * deployed stack.
 */
import { describe, expect, it } from "vitest";
import { readRuntimeEnv } from "./runtime-env.js";

const env = readRuntimeEnv();
const describeIfE2e = env?.fixtures.includes("basics") ? describe : describe.skip;

describeIfE2e("e2e: basics fixture (Phase 22)", () => {
	it("home page renders the title and ships scoped CSS", async () => {
		const url = `${env?.stackUrl.replace(/\/$/, "")}/basics/`;
		const res = await fetch(url);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("<h1");
		expect(body).toContain("Basics");
		// Scoped style emits the data-aflare-h attribute. Verify the
		// hash binds to both the <h1> and the <style> selector.
		const hashMatch = body.match(/data-aflare-h="([a-f0-9]{8})"/);
		expect(hashMatch).not.toBeNull();
		const hash = hashMatch?.[1];
		expect(body).toContain(`[data-aflare-h="${hash}"]`);
	});

	it("/basics/about returns the about page", async () => {
		const url = `${env?.stackUrl.replace(/\/$/, "")}/basics/about`;
		const res = await fetch(url);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("About page");
	});
});
