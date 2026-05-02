/**
 * Test worker entrypoint. The tests don't actually call this — they invoke
 * framework code directly inside the worker — but vitest-pool-workers needs
 * a `main` to boot.
 */
export default {
	async fetch(_req: Request): Promise<Response> {
		return new Response("astroflare workerd test harness");
	},
} satisfies ExportedHandler;
