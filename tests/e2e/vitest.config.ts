/**
 * Phase 20 e2e vitest project.
 *
 * Separate from the in-process pools (Layer A node, Layer B workerd,
 * Layer C miniflare) — these tests reach out to *real* Cloudflare
 * deployments via HTTPS. They're **opt-in**: tests skip themselves
 * when `AFLARE_E2E_URL` isn't set, so a developer running `pnpm test`
 * locally doesn't accidentally hit production.
 *
 * CI's `.github/workflows/e2e.yml` provisions a deployment, exports
 * `AFLARE_E2E_URL`, runs `vitest run --project e2e`, and then runs
 * `aflare-e2e teardown-all`. Local development uses
 * `aflare-e2e provision <fixture>` + `AFLARE_E2E_URL=...` to drive
 * the same flow against a personal Cloudflare account.
 */

import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "e2e",
		include: ["**/*.spec.ts"],
		// 30s — provisioning can be sluggish on first request to a fresh
		// edge node; this is "real network", not "in-process Miniflare".
		testTimeout: 30_000,
	},
});
