/**
 * Vitest workspace.
 *
 * Three test pools, mirroring §8 of the brief:
 *   - Layer A "node":      framework packages, plain Node, fast.
 *   - Layer B "workers":   @astroflare/host-cloudflare under workerd via vitest-pool-workers.
 *   - Layer C "miniflare": end-to-end integration tests against a Miniflare-booted Astroflare.
 *
 * Layer D (differential vs Astro) lives inside the compiler package's node pool.
 */
export default [
	"./packages/astroflare-core/vitest.config.ts",
	"./packages/astroflare-compiler/vitest.config.ts",
	"./packages/astroflare-runtime/vitest.config.ts",
	"./packages/astroflare-preview/vitest.config.ts",
	"./packages/astroflare-build/vitest.config.ts",
	"./packages/astroflare-test-utils/vitest.config.ts",
	"./packages/astroflare-content/vitest.config.ts",
	"./packages/astroflare-host-cloudflare/vitest.config.ts",
	"./tests/workerd/vitest.config.ts",
	"./tests/integration/vitest.config.ts",
];
