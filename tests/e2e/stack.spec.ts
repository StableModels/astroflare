/**
 * Phase 21 smoke — the project-worker stack is provisioned, reachable,
 * and exposes its diagnostic endpoints. The stack starts with no
 * deploys, so any route returns 404; `/_aflare/stack/info` and
 * `/_aflare/deploy/status` answer with the worker's view of state.
 *
 * Phase 22 introduces deploys + per-route assertions; this file
 * stays at the substrate level so a regression in
 * provisioning/binding/upload surfaces here cleanly without
 * depending on the full deploy pipeline.
 */

import { describe, expect, it } from "vitest";

const STACK_URL = process.env.AFLARE_STACK_URL;
const describeIfE2e = STACK_URL ? describe : describe.skip;

describeIfE2e("e2e: stack worker (Phase 21)", () => {
	it("is reachable + returns 404 for any route (no deploy yet)", async () => {
		// biome-ignore lint/style/noNonNullAssertion: guarded by describeIfE2e
		const res = await fetch(STACK_URL!);
		expect(res.status).toBe(404);
	});

	it("/_aflare/stack/info returns the worker's identity + currentDeploy=null", async () => {
		// biome-ignore lint/style/noNonNullAssertion: guarded by describeIfE2e
		const res = await fetch(`${STACK_URL!.replace(/\/$/, "")}/_aflare/stack/info`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			stackWorker: boolean;
			workspaceId: string;
			currentDeploy: string | null;
		};
		expect(body.stackWorker).toBe(true);
		expect(body.workspaceId).toBe("default");
		expect(body.currentDeploy).toBeNull();
	});

	it("/_aflare/deploy/status returns currentDeploy=null pre-deploy", async () => {
		// biome-ignore lint/style/noNonNullAssertion: guarded by describeIfE2e
		const res = await fetch(`${STACK_URL!.replace(/\/$/, "")}/_aflare/deploy/status`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { currentDeploy: string | null };
		expect(body.currentDeploy).toBeNull();
	});
});
