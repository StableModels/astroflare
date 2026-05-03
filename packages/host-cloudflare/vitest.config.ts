import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

/**
 * Layer B (§8.B): real workerd, real Hibernatable WS, real Worker Loader.
 *
 * The Workspace is mocked with a SQLite-DO test double in fixtures (Phase 1+);
 * for Phase 0 we only need this config to boot and pass a placeholder test.
 */
export default defineWorkersProject({
	test: {
		name: "host-cloudflare",
		include: ["src/**/*.test.ts"],
		// Closure-walked compile + render in `preview-handler.test.ts`
		// goes through a real executor — bumped from the default 5s.
		testTimeout: 30_000,
		poolOptions: {
			workers: {
				singleWorker: true,
				miniflare: {
					// Bumped from `2024-12-01` so the `[[worker_loaders]]`
					// block in `wrangler.toml` resolves.
					compatibilityDate: "2025-09-01",
					compatibilityFlags: ["nodejs_compat"],
					workerLoaders: {
						LOADER: {},
					},
				},
			},
		},
	},
});
