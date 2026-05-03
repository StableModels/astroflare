/**
 * Reference Mode A host worker. Routes every request to the
 * single-tenant `SiteDurableObject` (one site per host worker; multi-
 * site routing is a host concern, demonstrated in a sibling fixture).
 *
 * Forwarding to the DO via `stub.fetch(req)` is the canonical pattern:
 * the DO owns Workspace + module graph + HMR endpoint, and serves all
 * `/`, `/<route>`, `/_aflare/*` traffic.
 */

import { SiteDurableObject } from "./site-do.js";

export { SiteDurableObject };

interface Env {
	SITE_DO: DurableObjectNamespace<SiteDurableObject>;
	SITE_R2: R2Bucket;
	LOADER: WorkerLoader;
	DEPLOY_TOKEN?: string;
}

const SITE_ID = "default";

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const stub = env.SITE_DO.get(env.SITE_DO.idFromName(SITE_ID));
		return stub.fetch(req);
	},
};
