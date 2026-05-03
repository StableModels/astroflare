/**
 * Reference Mode B host worker (Phase 26b).
 *
 * Astroflare ships zero canonical worker entrypoints. This fixture
 * demonstrates the integration: instantiate `R2Snapshots` (with an
 * optional `prefix` for multi-env / multi-site path layouts), pass to
 * `createSnapshotHandler`, return its `fetch`.
 *
 * Total LOC: ~15.
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
		return createSnapshotHandler({ snapshots }).fetch(req);
	},
};
