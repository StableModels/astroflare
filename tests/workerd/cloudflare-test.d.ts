/**
 * Type augmentation for `cloudflare:test` so `env.LOADER` typechecks. Mirrors
 * Cloudflare's own pattern in `cloudflare/agents` (`packages/codemode/src/tests/cloudflare-test.d.ts`).
 *
 * The `LOADER` binding name has to match `wrangler.toml`'s
 * `[[worker_loaders]] binding = "LOADER"`.
 */

declare module "cloudflare:test" {
	interface ProvidedEnv {
		LOADER: WorkerLoader;
	}
}

export {};
