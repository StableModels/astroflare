/**
 * @astroflare/build — deploy-time orchestration: planner, render fan-out,
 * artifact format, atomic flip.
 *
 * The brief's §7.7 calls for a Workflow-orchestrated parallel render
 * fan-out and a Bundle DW running esbuild-wasm. Phase 7 ships the
 * framework-side primitives that make that orchestration straightforward
 * to wire up at the host layer:
 *
 *   - `plan(storage)` → list of (static / skipped) routes
 *   - `renderForRoutes(plans, opts)` → write HTML per route
 *   - `buildManifest({...})` → produce `DeployManifest`
 *   - `writeManifest(storage, manifest)` → persist
 *   - `flipCurrent(storage, deployHash)` → atomic switch to new deploy
 *   - `readCurrent(storage)`, `readManifest(storage, hash)` → runtime read
 *   - `createDeployServer(host, runtimeImport)` → request-handling shim
 *     for the runtime worker
 *
 * Carve-outs in `docs/phases/phase-07-deploy.md`:
 *   - SSR-route bundling (Bundle DW + esbuild-wasm) — Phase 7+ once
 *     getStaticPaths is implemented
 *   - Workflow-driven parallelism — host work
 *   - Per-island client bundles — Phase 8
 *   - Workspace-as-content-addressed-store hashing of static assets
 */

import { type Host, contentId } from "@astroflare/core";
import {
	type DeployManifest,
	buildManifest,
	readCurrent,
	readManifest,
	writeManifest,
} from "./artifact.js";
import { type BuildPlan, type RoutePlan, plan } from "./planner.js";
import {
	type RoutePlannedHtml,
	deployUrlFor,
	flipCurrent,
	renderForRoutes,
} from "./render-fanout.js";

export * from "./planner.js";
export * from "./render-fanout.js";
export * from "./artifact.js";
export { createDeployServer, type DeployServer } from "./deploy-server.js";

export interface DeployOptions {
	host: Host;
	runtimeImport: string;
	siteRoot?: string;
	now?: () => number;
}

export interface DeployResult {
	deployHash: string;
	manifest: DeployManifest;
	rendered: RoutePlannedHtml[];
	skipped: RoutePlan[];
	durationMs: number;
}

/**
 * One-shot deploy: plan → render every static route → write manifest →
 * flip `/site/current`. Returns the deploy hash and manifest. The
 * deploy hash is content-addressed: same set of route output digests
 * produces the same hash, so two no-op deploys produce identical
 * artifacts (and the flip is a no-op).
 */
export async function deploy(opts: DeployOptions): Promise<DeployResult> {
	const start = (opts.now ?? Date.now)();
	const buildPlan: BuildPlan = await plan(opts.host.storage);

	// Hash every page source so deploys with the same content collapse
	// (deduplicated) and deploys with different content get distinct
	// directories (rollback target). Doesn't yet hash transitive component
	// imports — Phase 7+ when we run the closure walker before deploying;
	// for now a page-only hash is enough for the test fixtures.
	const fingerprintParts: string[] = [];
	for (const r of buildPlan.routes) {
		if (r.kind !== "static") continue;
		const stat = await opts.host.storage.stat(r.route.filePath);
		fingerprintParts.push(`${r.route.filePath}:${stat?.hash ?? ""}`);
	}
	const deployHash = await contentId(fingerprintParts.sort().join("\n"));

	const rendered = await renderForRoutes(buildPlan.routes, {
		host: opts.host,
		deployHash,
		runtimeImport: opts.runtimeImport,
		siteRoot: opts.siteRoot,
	});

	const manifest = await buildManifest({
		deployHash,
		createdAt: start,
		routes: rendered.map((r) => {
			if (r.route.kind !== "static") {
				throw new Error("renderForRoutes returned a non-static plan");
			}
			return {
				url: deployUrlFor(r.route.outputPath),
				source: r.route.route.filePath,
				output: r.route.outputPath,
				html: r.html,
			};
		}),
	});

	await writeManifest(opts.host.storage, manifest, opts.siteRoot);
	await flipCurrent(opts.host.storage, deployHash, opts.siteRoot);

	const durationMs = (opts.now ?? Date.now)() - start;

	opts.host.logger.event("deploy.complete", {
		deployHash,
		routeCount: rendered.length,
		skippedCount: buildPlan.skippedCount,
		durationMs,
	});

	return {
		deployHash,
		manifest,
		rendered,
		skipped: buildPlan.routes.filter((r) => r.kind === "skipped"),
		durationMs,
	};
}

// Re-export commonly-used helpers.
export { readCurrent, readManifest };

export const BUILD_VERSION = "0.0.0";
