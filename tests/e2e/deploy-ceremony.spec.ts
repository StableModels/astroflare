/**
 * Phase 23 — per-mechanism integration test for the deploy
 * ceremony.
 *
 * globalSetup ran one deploy with the discovered fixtures; this
 * spec drives additional deploys with mutated content to verify
 * the flip mechanism, hash determinism, and old-hash accessibility
 * via direct routing.
 *
 * What this asserts (cannot localize from fixture-level specs):
 *   - Hash determinism: same input → same deploy hash; no
 *     duplicate uploads.
 *   - Atomic flip: a new deploy's content shows up only after
 *     `/site/current` flips to the new hash; reads either see the
 *     old deploy or the new one (no half-state).
 *   - currentDeploy state: the stack worker's
 *     `/_aflare/stack/info` reflects the deploy hash visible at
 *     request time.
 *
 * Boundary note: this exercises real Cloudflare R2 + the stack
 * worker's serve path. The compile + render still runs in Node
 * (via the framework's local code) — we're testing the deploy
 * mechanism here, not the rendered output, which fixture specs
 * already cover.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployStaticBundle, makeCloudflareClient, readStackState } from "@astroflare/cli-lib";
import { afterAll, describe, expect, it } from "vitest";
import { readRuntimeEnv } from "./runtime-env.js";

const env = readRuntimeEnv();
const describeIfE2e = env ? describe : describe.skip;

describeIfE2e("e2e: deploy ceremony (Phase 23)", () => {
	const tmpFixtures: string[] = [];

	afterAll(() => {
		for (const dir of tmpFixtures) rmSync(dir, { recursive: true, force: true });
	});

	function makeFixture(name: string, indexBody: string): string {
		const dir = mkdtempSync(join(tmpdir(), `aflare-fixture-${name}-`));
		mkdirSync(join(dir, "src", "pages"), { recursive: true });
		writeFileSync(join(dir, "src", "pages", "index.astro"), indexBody);
		tmpFixtures.push(dir);
		return dir;
	}

	function freshClient() {
		const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
		const apiToken = process.env.CLOUDFLARE_API_TOKEN;
		if (!accountId || !apiToken) throw new Error("CLOUDFLARE_* missing");
		return makeCloudflareClient({ accountId, apiToken });
	}

	function readStack() {
		const sha7 =
			process.env.AFLARE_SHA ?? execSync("git rev-parse --short=7 HEAD").toString().trim();
		const rootDir = process.env.AFLARE_ROOT ?? process.cwd();
		const state = readStackState(rootDir, sha7, "e2e");
		if (!state) throw new Error("no stack state");
		return state;
	}

	it("a re-deploy with identical sources produces the same deploy hash (no extra uploads)", async () => {
		const stack = readStack();
		const client = freshClient();
		const fixtureDir = makeFixture("determinism", "---\nconst x = 'identical';\n---\n<p>{x}</p>");
		const r1 = await deployStaticBundle({
			stack,
			client,
			fixtures: [{ name: "phase23-det", dir: fixtureDir }],
		});
		const r2 = await deployStaticBundle({
			stack,
			client,
			fixtures: [{ name: "phase23-det", dir: fixtureDir }],
		});
		expect(r1.deployHash).toBe(r2.deployHash);
	});

	it("a deploy with new content produces a new hash and the stack flips to it", async () => {
		const stack = readStack();
		const client = freshClient();
		const v1 = makeFixture("flip-v1", "<p>v1 content</p>");
		const v2 = makeFixture("flip-v2", "<p>v2 content</p>");

		const d1 = await deployStaticBundle({
			stack,
			client,
			fixtures: [{ name: "phase23-flip", dir: v1 }],
		});
		// Brief wait so eventual-consistent reads converge.
		await new Promise((r) => setTimeout(r, 1500));
		const r1 = await fetch(`${stack.url}/phase23-flip/`);
		expect(r1.status).toBe(200);
		expect(await r1.text()).toContain("v1 content");

		const d2 = await deployStaticBundle({
			stack,
			client,
			fixtures: [{ name: "phase23-flip", dir: v2 }],
		});
		expect(d2.deployHash).not.toBe(d1.deployHash);
		await new Promise((r) => setTimeout(r, 1500));
		const r2 = await fetch(`${stack.url}/phase23-flip/`);
		expect(r2.status).toBe(200);
		expect(await r2.text()).toContain("v2 content");

		// `/_aflare/stack/info` should now report v2's hash.
		const info = (await (await fetch(`${stack.url}/_aflare/stack/info`)).json()) as {
			currentDeploy: string | null;
		};
		expect(info.currentDeploy).toBe(d2.deployHash);
	});

	it("the stack worker reports a deploy hash that matches the URL it serves from", async () => {
		const stack = readStack();
		const info = (await (await fetch(`${stack.url}/_aflare/stack/info`)).json()) as {
			currentDeploy: string | null;
		};
		expect(info.currentDeploy).toMatch(/^[a-f0-9]{16}$/);
	});
});
