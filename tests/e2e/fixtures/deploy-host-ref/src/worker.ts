/**
 * Reference Mode B host worker (Phase 26b).
 *
 * Astroflare ships zero canonical worker entrypoints. This fixture
 * demonstrates the integration: instantiate `R2Snapshots` (with an
 * optional `prefix` for multi-env / multi-site path layouts), pass to
 * `createSnapshotHandler`, return its `fetch`.
 *
 * Adds a small `/_aflare/host/info` diagnostic endpoint so the e2e
 * harness can read the active snapshot hash without spinning up
 * extra infrastructure. The `/_aflare/stack/info` URL is preserved
 * as an alias for back-compat with existing specs.
 */

import { createSnapshotHandler } from "@astroflare/build";
import { R2Snapshots } from "@astroflare/host-cloudflare";

interface Env {
	SITE_BUCKET: R2Bucket;
	SITE_PREFIX?: string;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const snapshots = new R2Snapshots({
			bucket: env.SITE_BUCKET,
			prefix: env.SITE_PREFIX ?? "",
		});

		const url = new URL(req.url);
		if (
			url.pathname === "/_aflare/host/info" ||
			url.pathname === "/_aflare/stack/info" ||
			url.pathname === "/_aflare/deploy/status"
		) {
			const currentDeploy = await snapshots.current();
			return Response.json({
				stackWorker: true,
				host: true,
				workspaceId: "default",
				currentDeploy,
				prefix: env.SITE_PREFIX ?? "",
			});
		}

		return createSnapshotHandler({ snapshots }).fetch(req);
	},
};
