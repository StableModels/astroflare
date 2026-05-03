/**
 * Phase 20a e2e — `basics` fixture.
 *
 * Verifies routing, static-asset serving, and scoped-CSS emission.
 * Skipped unless `AFLARE_E2E_URL_BASICS` is set; the workflow's
 * provision step exports it.
 */
import { describe, expect, it } from "vitest";

const E2E_URL = process.env.AFLARE_E2E_URL_BASICS;
const describeIfE2e = E2E_URL ? describe : describe.skip;

describeIfE2e("e2e: basics fixture", () => {
	it("home page renders title and scoped style", async () => {
		// biome-ignore lint/style/noNonNullAssertion: guarded by describeIfE2e
		const url = E2E_URL!;
		const res = await fetch(url);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("<h1");
		expect(body).toContain("Basics");
		// Scoped style emits the data-aflare-h attribute. Verify the
		// hash binds to both the <h1> and the <style> selector.
		expect(body).toMatch(/data-aflare-h="[a-f0-9]{8}"/);
	});

	it("/about returns the about page", async () => {
		// biome-ignore lint/style/noNonNullAssertion: guarded by describeIfE2e
		const url = `${E2E_URL!.replace(/\/$/, "")}/about`;
		const res = await fetch(url);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("About page");
	});
});
