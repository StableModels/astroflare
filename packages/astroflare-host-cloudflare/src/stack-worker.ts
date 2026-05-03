/**
 * `stack-worker.ts` — slim Worker entrypoint for Phase 21.
 *
 * Same shape as `project-worker.ts` but trimmed: no live SSR
 * (no `@astroflare/preview`), no in-Worker `deploy()` (no
 * `@astroflare/compiler`). Serves pre-rendered artifacts from R2
 * via `createDeployServer`; returns 404 when there's no active
 * deploy.
 *
 * Why split? The full project worker pulls in esbuild-wasm,
 * `react-dom/server`, and the MDX `hast-util-to-estree` chain —
 * blowing past Cloudflare's compressed size budget. Splitting the
 * compile + render pipeline out of the parent Worker (it runs in
 * Worker Loader-spawned isolates, or client-side via `af deploy`)
 * keeps the parent slim. Phase 22 wires the remaining mechanisms.
 *
 * The DO class re-exports + binding shape match
 * `project-worker.ts` so a stack provisioned with this entrypoint
 * accepts a future upgrade to the full project-worker without DO
 * migrations.
 */

// Subpath imports keep the bundle slim — the package index re-exports
// `deploy()` (which transitively imports the compiler + MDX + React DOM
// Server). The stack worker only needs the request-handling shim and
// the artifact reader.
import { readCurrent } from "@astroflare/build/artifact";
import { createDeployServer } from "@astroflare/build/deploy-server";
import type { Host } from "@astroflare/core";
import { CoordinatorDurableObject, DurableObjectCoordinator } from "./coordinator-do.js";
import { R2Storage } from "./r2-storage.js";
import { HibernatingHmrTransport, HmrDurableObject } from "./transport.js";

export { CoordinatorDurableObject, HmrDurableObject };

/** Bindings the stack worker expects in `env`. */
export interface StackWorkerEnv {
	/** R2 bucket holding the project workspace + deploy artifacts. */
	FILES: R2Bucket;
	/** Coordinator DO namespace (one DO per workspace). */
	COORDINATOR_DO: DurableObjectNamespace<CoordinatorDurableObject>;
	/** HMR DO namespace (one DO per workspace). */
	HMR_DO: DurableObjectNamespace<HmrDurableObject>;
	/** Optional bearer token gating the deploy + rollback endpoints. */
	DEPLOY_TOKEN?: string;
}

const WORKSPACE = "default";

function makeHost(env: StackWorkerEnv): Host {
	const coordinatorStubFactory = () =>
		env.COORDINATOR_DO.get(env.COORDINATOR_DO.idFromName(WORKSPACE));
	const logger = makeLogger();
	return {
		storage: new R2Storage({ bucket: env.FILES }),
		coordinator: new DurableObjectCoordinator(coordinatorStubFactory),
		transport: new HibernatingHmrTransport(env.HMR_DO),
		// `executor` is unused by `createDeployServer` (which only reads
		// pre-rendered HTML from R2). Supply a throwing stub so the
		// `Host` type is satisfied without dragging in the executor
		// stack. Phase 22 introduces a real executor.
		executor: {
			runCached: () => {
				throw new Error("stack worker has no Executor — live SSR is unavailable until Phase 22");
			},
			runOnce: () => {
				throw new Error("stack worker has no Executor — live SSR is unavailable until Phase 22");
			},
		},
		clock: { now: () => Date.now() },
		logger,
	};
}

function makeLogger() {
	return {
		event(name: string, fields: Record<string, unknown>): void {
			console.log(JSON.stringify({ ...fields, name }));
		},
	};
}

export default {
	async fetch(req: Request, env: StackWorkerEnv): Promise<Response> {
		const host = makeHost(env);
		const url = new URL(req.url);

		// Diagnostic endpoints — useful for `af health` and post-deploy
		// smoke testing without needing real routes deployed.
		if (url.pathname === "/_aflare/stack/info") {
			const currentDeploy = await readCurrent(host.storage);
			return new Response(
				JSON.stringify({
					stackWorker: true,
					workspaceId: WORKSPACE,
					currentDeploy,
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}
		if (url.pathname === "/_aflare/deploy/status") {
			const currentDeploy = await readCurrent(host.storage);
			return new Response(JSON.stringify({ currentDeploy }), {
				headers: { "content-type": "application/json" },
			});
		}

		// Try serving from the active deploy artifact.
		const currentDeploy = await readCurrent(host.storage);
		if (currentDeploy) {
			const deployServer = createDeployServer({ host });
			const r = await deployServer.fetch(req);
			if (r.status !== 404) return r;
		}

		return new Response("Not found", {
			status: 404,
			headers: { "content-type": "text/plain;charset=utf-8" },
		});
	},
};
