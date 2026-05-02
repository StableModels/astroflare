import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

/**
 * Layer C (§8.C): full Astroflare assembly in Miniflare with fixture projects.
 *
 * Latency budgets asserted here in CI:
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
				main: "./harness.ts",
				miniflare: {
					compatibilityDate: "2024-12-01",
					compatibilityFlags: ["nodejs_compat"],
				},
			},
		},
	},
});
