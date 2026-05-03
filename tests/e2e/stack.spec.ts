/**
 * Phase 21 stack-worker smoke. Verifies the project-worker stack is
 * reachable, exposes its identity endpoint, and 404s on un-deployed
 * routes. Phase 22 deploys fixtures during globalSetup; this spec
 * stays at the stack-worker level (testing what the stack does, not
 * what's deployed onto it).
 */
import { describe, expect, it } from "vitest";
import { readRuntimeEnv } from "./runtime-env.js";

const env = readRuntimeEnv();
const describeIfE2e = env ? describe : describe.skip;

describeIfE2e("e2e: stack worker (Phase 21)", () => {
	it("/_aflare/stack/info returns the worker's identity", async () => {
		const url = `${env?.stackUrl.replace(/\/$/, "")}/_aflare/stack/info`;
		const res = await fetch(url);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			stackWorker: boolean;
			workspaceId: string;
			currentDeploy: string | null;
		};
		expect(body.stackWorker).toBe(true);
		expect(body.workspaceId).toBe("default");
		// Phase 22 deploys during globalSetup → a deploy hash is set.
		// Without fixtures the field is null. The assertion is
		// structural either way: 16-hex hash if present.
		if (body.currentDeploy !== null) {
			expect(body.currentDeploy).toMatch(/^[a-f0-9]{16}$/);
		}
	});

	it("/_aflare/deploy/status mirrors currentDeploy", async () => {
		const infoRes = await fetch(`${env?.stackUrl.replace(/\/$/, "")}/_aflare/stack/info`);
		const info = (await infoRes.json()) as { currentDeploy: string | null };
		const statusRes = await fetch(`${env?.stackUrl.replace(/\/$/, "")}/_aflare/deploy/status`);
		expect(statusRes.status).toBe(200);
		const status = (await statusRes.json()) as { currentDeploy: string | null };
		expect(status.currentDeploy).toBe(info.currentDeploy);
	});

	it("returns 404 for routes outside the deployed fixture set", async () => {
		const res = await fetch(`${env?.stackUrl.replace(/\/$/, "")}/this-route-doesnt-exist`);
		expect(res.status).toBe(404);
	});
});
