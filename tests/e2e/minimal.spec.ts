/**
 * Phase 22 e2e — `minimal` fixture.
 *
 * The fixture's source (`tests/e2e/fixtures/minimal/src/pages/index.astro`)
 * gets compiled + rendered by the framework's local code during
 * globalSetup, uploaded to R2, and served from the stack worker
 * at `/minimal/`.
 */
import { describe, expect, it } from "vitest";
import { readRuntimeEnv } from "./runtime-env.js";

const env = readRuntimeEnv();
const describeIfE2e = env?.fixtures.includes("minimal") ? describe : describe.skip;

describeIfE2e("e2e: minimal fixture (Phase 22)", () => {
	it("GET /minimal/ returns 200 with the rendered greeting", async () => {
		const url = `${env?.stackUrl.replace(/\/$/, "")}/minimal/`;
		const res = await fetch(url, { redirect: "follow" });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const body = await res.text();
		expect(body).toContain("<h1>Hello, edge</h1>");
		expect(body).toContain("aflare-e2e minimal");
	});
});
