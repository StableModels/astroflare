/**
 * Miniflare integration harness entrypoint.
 *
 * Phase 3+ replace this with a real Project Worker that mounts the framework
 * over `@astroflare/host-cloudflare`. For Phase 0 it exists only so workerd
 * has something to serve and `vitest-pool-workers` can boot.
 */
export default {
	async fetch(_req: Request): Promise<Response> {
		return new Response("astroflare integration harness — Phase 0 placeholder");
	},
} satisfies ExportedHandler;
