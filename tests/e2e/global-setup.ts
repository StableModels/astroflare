/**
 * Vitest globalSetup for the e2e project.
 *
 * Provisions both Astroflare lifecycle modes against real Cloudflare:
 *
 *   - Mode B (deploy stack): a slim stack worker serving R2-stored
 *     pre-rendered HTML. Fixtures compile + render locally (Node)
 *     and the result lands in R2; the worker's only job is to read
 *     and serve.
 *
 *   - Mode A (preview stack): a preview worker that runs the
 *     framework's compile + render path in spawned Worker Loader
 *     isolates on Cloudflare itself. Source files live in R2; the
 *     worker reads, compiles, renders on demand.
 *
 * Both stacks coexist on a single SHA — each gets its own worker +
 * R2 bucket. Phase 25's `provisionPreview` requires Worker Loader,
 * which is paid-plan only; the account this repo points at is on
 * the paid plan.
 *
 * What this exercises end-to-end:
 *   - Stack + preview provisioning (Phases 21, 25)
 *   - The framework's local compile + render (Mode B path)
 *   - The R2 upload + atomic flip ceremony (Mode B path)
 *   - The framework's in-Worker compile + render (Mode A path)
 *   - File upload + R2 write + HMR coordinator notify (Mode A)
 *
 * Spec files don't read `process.env` directly because vitest's
 * worker pool snapshots env at fork time and globalSetup mutations
 * don't propagate. Per-run state is written to
 * `tests/e2e/.state/<sha>/runtime.json` instead; specs call
 * `readRuntimeEnv()` from disk fresh.
 *
 * Local-friendly: without CLOUDFLARE_* creds, setup is a no-op
 * and specs self-skip (the runtime.json file is absent).
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import {
	type FixtureSource,
	type PreviewState,
	deployStaticBundle,
	destroyPreview,
	destroyStack,
	loadPreviewWorkerBundle,
	loadStackWorkerBundle,
	makeCloudflareClient,
	provisionPreview,
	provisionStack,
	uploadFiles,
} from "@astroflare/cli-lib";
import { clearRuntimeEnv, writeRuntimeEnv } from "./runtime-env.js";

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
	const sha7 = process.env.AFLARE_SHA ?? execSync("git rev-parse --short=7 HEAD").toString().trim();
	const rootDir = process.env.AFLARE_ROOT ?? process.cwd();
	return { accountId, apiToken, sha7, rootDir };
}

function discoverFixtures(rootDir: string): readonly FixtureSource[] {
	const dir = `${rootDir}/tests/e2e/fixtures`;
	if (!existsSync(dir)) return [];
	const out: FixtureSource[] = [];
	for (const name of readdirSync(dir)) {
		const fixtureDir = `${dir}/${name}`;
		const pagesDir = `${fixtureDir}/src/pages`;
		try {
			if (statSync(pagesDir).isDirectory()) out.push({ name, dir: fixtureDir });
		} catch {}
	}
	return out;
}

export default async function setup(): Promise<() => Promise<void>> {
	if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
		console.log("[e2e setup] CLOUDFLARE_* credentials missing — skipping provisioning");
		// A prior credentialed run may have left a `runtime.json` on
		// disk pointing at workers that have since been torn down.
		// Wipe it so specs self-skip cleanly via `readRuntimeEnv()`.
		clearRuntimeEnv();
		return async () => {};
	}
	const ctx = readContext();
	const client = makeCloudflareClient({
		accountId: ctx.accountId,
		apiToken: ctx.apiToken,
	});

	console.log(`[e2e setup] provisioning stack for sha=${ctx.sha7}`);
	const stackState = await provisionStack({
		rootDir: ctx.rootDir,
		sha7: ctx.sha7,
		name: "e2e",
		client,
		stackWorkerBundle: loadStackWorkerBundle(ctx.rootDir),
	});
	console.log(`[e2e setup]   stack → ${stackState.url}`);

	const fixtures = discoverFixtures(ctx.rootDir);
	let deployHash: string | null = null;
	if (fixtures.length > 0) {
		console.log(`[e2e setup] deploying ${fixtures.length} fixture(s) as one atomic bundle`);
		const result = await deployStaticBundle({
			stack: stackState,
			client,
			fixtures,
		});
		console.log(`[e2e setup]   deploy=${result.deployHash} routes=${result.routes.length}`);
		for (const r of result.routes) {
			console.log(`[e2e setup]     ${r.fixture}\t${r.route}`);
		}
		deployHash = result.deployHash;
	} else {
		console.log("[e2e setup] no .astro fixtures discovered — skipping deploy");
	}

	// Provision the preview-worker stack alongside the deploy stack.
	// Worker Loader is paid-plan only on Cloudflare; this account is
	// on a paid plan, so provisioning is a hard expectation — failures
	// here are real errors that must surface.
	console.log("[e2e setup] provisioning preview-worker stack");
	const previewState: PreviewState = await provisionPreview({
		rootDir: ctx.rootDir,
		sha7: ctx.sha7,
		name: "e2e",
		client,
		previewWorkerBundle: loadPreviewWorkerBundle(ctx.rootDir),
	});
	console.log(`[e2e setup]   preview → ${previewState.url}`);

	// Wait for DNS settle BEFORE uploading files. Both stacks were
	// just created on workers.dev; the upload step POSTs to the
	// preview's workers.dev URL, which 404s until DNS propagates.
	// `deployStaticBundle` above runs through the Cloudflare REST
	// API directly and doesn't have this issue.
	const settleMs = Number(process.env.AFLARE_SETTLE_MS ?? 8000);
	if (settleMs > 0) {
		console.log(`[e2e setup] waiting ${settleMs}ms for workers.dev DNS`);
		await new Promise((resolve) => setTimeout(resolve, settleMs));
	}

	// Upload one fixture's source tree to the preview workspace.
	// The preview worker resolves URL pathnames against
	// `/src/pages/...` with no fixture prefix, so the workspace
	// holds exactly one fixture's source set at a time. Multi-fixture
	// preview support (path-prefixed routing) is Phase 25b carry-over.
	const previewFixture = fixtures.find((f) => f.name === "minimal") ?? fixtures[0];
	if (!previewFixture) {
		throw new Error("[e2e setup] no fixture available to upload to the preview workspace");
	}
	console.log(`[e2e setup] uploading fixture '${previewFixture.name}' to preview`);
	const uploadResult = await pollAndUpload(previewState, previewFixture.dir);
	console.log(`[e2e setup]   ${uploadResult.uploaded.length} file(s) uploaded`);
	const previewFixtureNames = [previewFixture.name];

	writeRuntimeEnv({
		stackUrl: stackState.url,
		deployHash,
		fixtures: fixtures.map((f) => f.name),
		previewUrl: previewState.url,
		previewDeployToken: previewState.deployToken,
		previewFixtures: previewFixtureNames,
	});
	console.log(
		`[e2e setup]   wrote runtime env: ${fixtures.length} fixtures, deploy=${deployHash}, preview=${previewState.url}`,
	);

	return async function teardown() {
		// Wipe runtime.json first so any subsequent test run that
		// doesn't have creds doesn't read torn-down URLs.
		clearRuntimeEnv();
		console.log("[e2e teardown] destroying stack");
		try {
			await destroyStack({
				rootDir: ctx.rootDir,
				sha7: stackState.sha7,
				name: stackState.name,
				client,
			});
			console.log(`[e2e teardown]   destroyed stack ${stackState.workerName}`);
		} catch (err) {
			console.error(`[e2e teardown]   FAILED to destroy stack: ${(err as Error).message}`);
		}
		console.log("[e2e teardown] destroying preview");
		try {
			await destroyPreview({
				rootDir: ctx.rootDir,
				sha7: previewState.sha7,
				name: previewState.name,
				client,
			});
			console.log(`[e2e teardown]   destroyed preview ${previewState.workerName}`);
		} catch (err) {
			console.error(`[e2e teardown]   FAILED to destroy preview: ${(err as Error).message}`);
		}
	};
}

/**
 * `uploadFiles` with retry-on-DNS-not-ready. Even after the fixed
 * settle wait, workers.dev DNS occasionally lags; we retry with
 * backoff so a single first-request 404 doesn't fail provisioning.
 */
async function pollAndUpload(preview: PreviewState, fixtureDir: string) {
	const maxAttempts = 6;
	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await uploadFiles({ preview, fixtureDir });
		} catch (err) {
			lastErr = err;
			const msg = (err as Error).message;
			// 404 from workers.dev is "not yet propagated"; anything else
			// (auth, server error, network) is a real failure.
			if (!msg.includes("→ 404") && !msg.includes("404:")) throw err;
			const waitMs = 2000 * attempt;
			console.log(`[e2e setup]   upload attempt ${attempt} got 404; retry in ${waitMs}ms`);
			await new Promise((resolve) => setTimeout(resolve, waitMs));
		}
	}
	throw lastErr;
}
