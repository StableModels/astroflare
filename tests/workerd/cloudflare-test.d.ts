/**
 * Type augmentation for `cloudflare:test` so `env.LOADER` typechecks. Mirrors
 * Cloudflare's own pattern in `cloudflare/agents` (`packages/codemode/src/tests/cloudflare-test.d.ts`).
 *
 * The `LOADER` binding name has to match `vitest.config.ts`'s
 * `miniflare.workerLoaders.LOADER`.
 */

declare module "cloudflare:test" {
	interface ProvidedEnv {
		LOADER: WorkerLoader;
	}
}
