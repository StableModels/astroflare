/**
 * Vitest globalSetup for the e2e project.
 *
 * Provisions Mode B (deploy stack) against real Cloudflare. Mode A
 * (preview) is host-driven as of Phase 26 — provisioning belongs in the
 * host application's lifecycle, not in `af`. A host-driven preview
 * fixture under `tests/e2e/fixtures/preview-host-ref/` will plug into
 * this harness in a follow-up; until then, e2e Mode A coverage is
 * deferred.
 *
 * What this exercises end-to-end:
 *   - Stack provisioning (Phase 21)
 *   - The framework's local compile + render (Mode B path)
 *   - The R2 upload + atomic flip ceremony (Mode B path)
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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	type FixtureSource,
	deployStaticBundle,
	destroyPreviewHost,
	destroyStack,
	loadPreviewHostBundle,
	loadStackWorkerBundle,
	makeCloudflareClient,
	provisionPreviewHost,
	provisionStack,
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

	// Phase 26 reference preview host (Mode A). Best-effort: when the
	// bundle is missing or provisioning fails, the preview-host spec
	// self-skips without failing the suite.
	let previewHostUrl: string | null = null;
	let previewHostDeployToken: string | null = null;
	let previewState: { sha7: string; name: string; workerName: string } | null = null;
	const previewBundlePath = resolve(
		ctx.rootDir,
		"tests/e2e/fixtures/preview-host-ref/dist/worker.bundle.js",
	);
	if (existsSync(previewBundlePath)) {
		try {
			console.log("[e2e setup] provisioning preview-host-ref");
			const provisioned = await provisionPreviewHost({
				rootDir: ctx.rootDir,
				sha7: ctx.sha7,
				name: "e2e",
				client,
				previewHostBundle: loadPreviewHostBundle(ctx.rootDir),
			});
			previewHostUrl = provisioned.url;
			previewHostDeployToken = provisioned.deployToken;
			previewState = {
				sha7: provisioned.sha7,
				name: provisioned.name,
				workerName: provisioned.workerName,
			};
			console.log(`[e2e setup]   preview-host → ${provisioned.url}`);

			const indexAstroPath = resolve(
				ctx.rootDir,
				"tests/e2e/fixtures/preview-host-ref/files/index.astro",
			);
			if (existsSync(indexAstroPath)) {
				const settleMs = Number(process.env.AFLARE_SETTLE_MS ?? 8000);
				if (settleMs > 0) {
					console.log(`[e2e setup] waiting ${settleMs}ms for workers.dev DNS`);
					await new Promise((r) => setTimeout(r, settleMs));
				}
				const body = readFileSync(indexAstroPath);
				let attempt = 0;
				const maxAttempts = 6;
				while (attempt < maxAttempts) {
					attempt++;
					try {
						const res = await fetch(
							`${provisioned.url.replace(/\/$/, "")}/_aflare/site/file?path=/src/pages/index.astro`,
							{
								method: "POST",
								headers: {
									Authorization: `Bearer ${provisioned.deployToken}`,
									"content-type": "application/octet-stream",
								},
								body: new Uint8Array(body),
							},
						);
						if (!res.ok) {
							const text = await res.text();
							if (res.status === 404 && attempt < maxAttempts) {
								await new Promise((r) => setTimeout(r, 2000 * attempt));
								continue;
							}
							throw new Error(`upload index.astro: ${res.status}: ${text}`);
						}
						console.log("[e2e setup]   uploaded preview-host-ref/index.astro");
						break;
					} catch (err) {
						if (attempt >= maxAttempts) throw err;
					}
				}
			}
		} catch (err) {
			console.error(
				`[e2e setup]   preview-host provisioning failed (continuing): ${(err as Error).message}`,
			);
			previewHostUrl = null;
			previewHostDeployToken = null;
		}
	} else {
		console.log(
			"[e2e setup] preview-host bundle not built — run `node tests/e2e/fixtures/preview-host-ref/build.mjs`",
		);
	}

	writeRuntimeEnv({
		stackUrl: stackState.url,
		deployHash,
		fixtures: fixtures.map((f) => f.name),
		previewHostUrl,
		previewHostDeployToken,
	});
	console.log(
		`[e2e setup]   wrote runtime env: ${fixtures.length} fixtures, deploy=${deployHash}, preview=${previewHostUrl ?? "none"}`,
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
		if (previewState) {
			console.log("[e2e teardown] destroying preview-host");
			try {
				await destroyPreviewHost({
					rootDir: ctx.rootDir,
					sha7: previewState.sha7,
					name: previewState.name,
					client,
				});
				console.log(`[e2e teardown]   destroyed preview-host ${previewState.workerName}`);
			} catch (err) {
				console.error(`[e2e teardown]   FAILED to destroy preview-host: ${(err as Error).message}`);
			}
		}
	};
}
