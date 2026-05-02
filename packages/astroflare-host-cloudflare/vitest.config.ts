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
		poolOptions: {
			workers: {
				singleWorker: true,
				miniflare: {
					compatibilityDate: "2024-12-01",
					compatibilityFlags: ["nodejs_compat"],
				},
			},
		},
	},
});
