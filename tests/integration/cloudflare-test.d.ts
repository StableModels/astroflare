/**
 * Type augmentation for `cloudflare:test` so `env.*` typechecks. Mirrors
 * the workerd-pool definition in `tests/workerd/cloudflare-test.d.ts`.
 *
 * Every binding name has to match `wrangler.toml`.
 */

import type { CoordinatorDurableObject, HmrDurableObject } from "@astroflare/host-cloudflare";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		FILES: R2Bucket;
		COORDINATOR_DO: DurableObjectNamespace<CoordinatorDurableObject>;
		HMR_DO: DurableObjectNamespace<HmrDurableObject>;
		LOADER: WorkerLoader;
		DEPLOY_TOKEN: string;
	}
}
