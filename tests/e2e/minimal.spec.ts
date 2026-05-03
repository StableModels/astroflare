/**
 * Phase 20 e2e — `minimal` fixture.
 *
 * Asserts the simplest end-to-end signal: a deployed Astroflare
 * `/` route returns 200, the rendered HTML contains the page's
 * literal greeting, and the response is HTML.
 *
 * Skipped unless `AFLARE_URL` is set — the test only runs in
 * CI's e2e workflow (or when a developer manually drives a
 * deploy with `aflare-e2e provision minimal`).
 */
import { describe, expect, it } from "vitest";

const E2E_URL = process.env.AFLARE_URL;
const describeIfE2e = E2E_URL ? describe : describe.skip;

describeIfE2e("e2e: minimal fixture", () => {
	it("GET / returns 200 with the rendered greeting", async () => {
		// biome-ignore lint/style/noNonNullAssertion: guarded by describeIfE2e
		const url = E2E_URL!;
		const res = await fetch(url, { redirect: "follow" });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const body = await res.text();
		expect(body).toContain("Hello, edge");
	});

	it("GET /missing-route returns 404", async () => {
		// biome-ignore lint/style/noNonNullAssertion: guarded by describeIfE2e
		const url = `${E2E_URL!.replace(/\/$/, "")}/missing-route`;
		const res = await fetch(url);
		expect(res.status).toBe(404);
	});
});
