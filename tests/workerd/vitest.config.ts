import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

/**
 * Layer B (§8.B) tests for framework code that must run under real workerd.
 *
 * Hosts:
 *   - the runtime (`@astroflare/runtime/internal`) — runs in workerd in
 *     production, so Layer-B-shaped tests are the truthful bar.
 *   - the compiler's end-to-end pipeline — compile a `.astro`, execute the
 *     compiled module inside workerd, verify HTML.
 *
 * Vite remains in the test orchestration (vitest itself, test discovery,
 * config), but is OUT of the framework runtime path: once vitest-pool-workers
 * boots the worker, the test code and the framework code it exercises both
 * run in workerd. Module loading inside the worker uses workerd's resolver
 * — no SSR transform, no `loadAndTransform`, no rollup.
 */
export default defineWorkersProject({
	test: {
		name: "workerd",
		include: ["**/*.test.ts"],
		poolOptions: {
			workers: {
				singleWorker: true,
				// Disable isolated-storage because Hibernatable WS DOs hold open
				// sockets across test boundaries; vitest-pool-workers' default
				// per-test storage stack frames conflict with that.
				// See https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage
				isolatedStorage: false,
				main: "./harness.ts",
				miniflare: {
					compatibilityDate: "2025-09-01",
					compatibilityFlags: ["nodejs_compat"],
					// Worker Loader binding (Phase 2.5b unblock). Configured here
					// rather than in wrangler.toml because vitest-pool-workers' TOML
					// parser predates `worker_loaders` and ignores the field; the
					// programmatic Miniflare option is wired through directly.
					workerLoaders: { LOADER: {} },
				},
			},
		},
	},
});
