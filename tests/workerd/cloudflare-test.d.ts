/**
 * Type augmentation for `cloudflare:test` so `env.LOADER` typechecks. Mirrors
 * Cloudflare's own pattern in `cloudflare/agents` (`packages/codemode/src/tests/cloudflare-test.d.ts`).
 *
 * The binding names have to match `vitest.config.ts`'s
 * `miniflare.workerLoaders.LOADER` / `miniflare.r2Buckets.SITE_R2`.
 */

declare module "cloudflare:test" {
	interface ProvidedEnv {
		LOADER: WorkerLoader;
		SITE_R2: R2Bucket;
	}
}
