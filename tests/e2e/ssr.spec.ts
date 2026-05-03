/**
 * Phase 20a e2e — `ssr` fixture.
 *
 * Verifies a `.ts` endpoint deployed as a server route: echo back
 * search params as JSON. Skipped unless `AFLARE_URL_SSR` is set.
 */
import { describe, expect, it } from "vitest";

const E2E_URL = process.env.AFLARE_URL_SSR;
const describeIfE2e = E2E_URL ? describe : describe.skip;

describeIfE2e("e2e: ssr fixture", () => {
	it("/api/echo returns JSON with the search params echoed back", async () => {
		// biome-ignore lint/style/noNonNullAssertion: guarded by describeIfE2e
		const url = `${E2E_URL!.replace(/\/$/, "")}/api/echo?msg=hello&n=42`;
		const res = await fetch(url);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as { params: Record<string, string>; time: number };
		expect(body.params.msg).toBe("hello");
		expect(body.params.n).toBe("42");
		expect(typeof body.time).toBe("number");
	});
});
