/**
 * Vitest workspace.
 *
 * Three test layers post-Phase 26b:
 *   - Layer A "node":     framework packages, plain Node, fast.
 *   - Layer B "workerd":  @astroflare/host-cloudflare and others under
 *                         workerd via vitest-pool-workers.
 *   - Layer D "e2e":      real Cloudflare. Provisions on push-to-main +
 *                         nightly; skips locally without credentials.
 *
 * The Phase-15-era Layer C (Miniflare integration project) was retired
 * with Phase 26b's hard-cut — its tests exercised the deleted DOs.
 * Equivalent end-to-end coverage lands in Layer D against the
 * reference fixtures (`preview-host-ref` + `deploy-host-ref`).
 */
export default [
	"./packages/core/vitest.config.ts",
	"./packages/compiler/vitest.config.ts",
	"./packages/runtime/vitest.config.ts",
	"./packages/preview/vitest.config.ts",
	"./packages/build/vitest.config.ts",
	"./packages/test-utils/vitest.config.ts",
	"./packages/content/vitest.config.ts",
	"./packages/cli/vitest.config.ts",
	"./packages/cli-lib/vitest.config.ts",
	"./packages/host-cloudflare/vitest.config.ts",
	"./packages/starter/vitest.config.ts",
	"./tests/workerd/vitest.config.ts",
	"./tests/e2e/vitest.config.ts",
	"./examples/minimal-blog/vitest.config.ts",
];
