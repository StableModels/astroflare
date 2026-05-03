import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

/**
 * Layer C (§8.C): full Astroflare assembly in Miniflare with fixture
 * projects. Phase 15 wires the project-worker entrypoint over real R2 +
 * DO + Worker Loader bindings; tests pre-seed R2 via `env.FILES.put`
 * and exercise the live SSR pipeline through `SELF.fetch`.
 *
 * Latency budgets asserted here in CI (acceptance §11.2/3):
 *   - cold preview p95 <300 ms
 *   - warm preview p95 <60 ms
 *   - HMR roundtrip p95 <100 ms
 * If they flake, fix performance — don't loosen the bound.
 */
export default defineWorkersProject({
	test: {
		name: "integration",
		include: ["**/*.test.ts"],
		poolOptions: {
			workers: {
				singleWorker: true,
				// DOs hold open WebSockets / sqlite state across tests; the
				// per-test isolated-storage stack frame conflicts with the
				// HMR DO's hibernating sockets.
				isolatedStorage: false,
				main: "./harness.ts",
				miniflare: {
					compatibilityDate: "2025-09-01",
					compatibilityFlags: ["nodejs_compat"],
					workerLoaders: { LOADER: {} },
					durableObjects: {
						COORDINATOR_DO: { className: "CoordinatorDurableObject" },
						HMR_DO: { className: "HmrDurableObject" },
					},
					r2Buckets: ["FILES"],
					// vars in wrangler.toml don't propagate to vitest-pool-workers'
					// Miniflare config; bind explicitly here.
					bindings: { DEPLOY_TOKEN: "test-deploy-token" },
				},
			},
		},
	},
});
