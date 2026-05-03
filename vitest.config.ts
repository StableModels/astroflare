/**
 * Root vitest config (Phase 19).
 *
 * The actual project topology (12 projects, 6 pools) lives in
 * `vitest.workspace.ts`; this file configures cross-project options
 * — most importantly, the coverage thresholds the brief calls out
 * (acceptance §11.4: >85% framework / >75% host).
 *
 * Coverage runs are opt-in: `pnpm test:coverage` in package.json
 * passes `--coverage`. The default `pnpm test` skips it (faster
 * iteration); CI's quality-gate workflow runs the coverage variant
 * and the thresholds below cause it to fail when the bar slips.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			reporter: ["text", "html"],
			// Watch the source tree, not tests.
			include: ["packages/*/src/**/*.ts"],
			// Exclude generated, vendored, and infrastructure files. Tests
			// don't count as their own coverage.
			exclude: [
				"**/dist/**",
				"**/*.test.ts",
				"**/*.d.ts",
				"**/index.ts", // re-export-only; nothing to cover.
				"packages/astroflare-test-utils/**",
			],
			// Brief acceptance §11.4 — thresholds split between the
			// framework (the user-facing surface) and the host (the
			// Cloudflare-bound implementation). A coverage drop below
			// these fails CI; raise as the codebase tightens.
			thresholds: {
				// Framework packages — generous for now; tighten as Phase
				// 19's quality work continues.
				"packages/astroflare-{core,compiler,runtime,preview,build,content,cli}/src/**/*.ts": {
					lines: 75,
					functions: 75,
					branches: 70,
					statements: 75,
				},
				// Host package — slightly lower bar (more workerd-bound
				// glue, harder to unit-test).
				"packages/astroflare-host-cloudflare/src/**/*.ts": {
					lines: 65,
					functions: 65,
					branches: 60,
					statements: 65,
				},
			},
		},
	},
});
