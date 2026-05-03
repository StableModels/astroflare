/**
 * Vitest globalSetup for the e2e project.
 *
 * Runs ONCE before any spec, in the same Node process that drives
 * the test runner. We use it to provision every fixture under
 * `tests/e2e/fixtures/` against real Cloudflare; spec files read
 * the resulting URLs from `process.env` (set here, inherited by
 * worker pools).
 *
 * Vitest's globalSetup contract: the default export `setup(ctx)`
 * runs before tests, the `teardown()` returned from setup runs
 * after — same shape as a `beforeAll`/`afterAll` pair scoped to
 * the whole project.
 *
 * The teardown step always runs, even on test-suite failure, so
 * a flaky run never leaks Cloudflare resources. State files in
 * `tests/e2e/.state/<sha7>/` outlive the run only when the
 * teardown itself fails (rare); operators clean those up via
 * `af destroy-all` or `af gc`.
 */

import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { loadFixtureBundle } from "@astroflare/cli/commands/fixtures";
import {
	type FixtureState,
	makeCloudflareClient,
	provisionFixture,
	teardownFixture,
} from "@astroflare/e2e";

interface ProvisionContext {
	accountId: string;
	apiToken: string;
	sha7: string;
	rootDir: string;
}

function readContext(): ProvisionContext {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
	if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required for e2e tests");
	if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required for e2e tests");
	const sha7 =
		process.env.AFLARE_E2E_SHA ?? execSync("git rev-parse --short=7 HEAD").toString().trim();
	const rootDir = process.env.AFLARE_E2E_ROOT ?? process.cwd();
	return { accountId, apiToken, sha7, rootDir };
}

function discoverFixtures(rootDir: string): readonly string[] {
	const dir = `${rootDir}/tests/e2e/fixtures`;
	return readdirSync(dir).filter((name) => {
		try {
			return statSync(`${dir}/${name}/worker.js`).isFile();
		} catch {
			return false;
		}
	});
}

/** Spec files read these env vars: */
function urlEnvVar(fixture: string): string {
	if (fixture === "minimal") return "AFLARE_E2E_URL";
	return `AFLARE_E2E_URL_${fixture.toUpperCase()}`;
}

export default async function setup(): Promise<() => Promise<void>> {
	// Local-friendly: when Cloudflare credentials aren't available
	// (e.g. a developer running `pnpm test` without unlocking
	// `.dev.vars`), skip provisioning entirely. The spec files
	// already self-skip when their `AFLARE_E2E_URL_*` env vars are
	// missing, so this is a clean no-op.
	if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
		console.log("[e2e setup] CLOUDFLARE_* credentials missing — skipping provisioning");
		return async () => {};
	}
	const ctx = readContext();
	const client = makeCloudflareClient({
		accountId: ctx.accountId,
		apiToken: ctx.apiToken,
	});
	const fixtures = discoverFixtures(ctx.rootDir);
	const provisioned: FixtureState[] = [];

	console.log(`[e2e setup] provisioning ${fixtures.length} fixture(s) for sha=${ctx.sha7}`);
	for (const fixture of fixtures) {
		const bundle = await loadFixtureBundle(fixture, ctx.rootDir);
		const state = await provisionFixture({
			rootDir: ctx.rootDir,
			sha7: ctx.sha7,
			fixture,
			client,
			workerBundle: bundle,
		});
		process.env[urlEnvVar(fixture)] = state.url;
		console.log(`[e2e setup]   ${fixture} → ${state.url}`);
		provisioned.push(state);
	}

	// workers.dev DNS settles within a couple of seconds — wait once
	// for everyone before any spec issues a fetch.
	const settleMs = Number(process.env.AFLARE_E2E_SETTLE_MS ?? 8000);
	if (provisioned.length > 0 && settleMs > 0) {
		console.log(`[e2e setup] waiting ${settleMs}ms for workers.dev DNS`);
		await new Promise((resolve) => setTimeout(resolve, settleMs));
	}

	return async function teardown() {
		console.log(`[e2e teardown] destroying ${provisioned.length} fixture(s)`);
		for (const state of provisioned) {
			try {
				await teardownFixture({
					rootDir: ctx.rootDir,
					sha7: state.sha7,
					fixture: state.fixture,
					client,
				});
				console.log(`[e2e teardown]   destroyed ${state.workerName}`);
			} catch (err) {
				console.error(
					`[e2e teardown]   FAILED to destroy ${state.workerName}: ${(err as Error).message}`,
				);
			}
		}
	};
}
