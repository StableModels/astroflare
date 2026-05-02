/**
 * Test worker entrypoint. Exports the framework's Durable Object classes so
 * vitest-pool-workers can wire up the bindings, and provides a placeholder
 * `fetch` handler (tests invoke framework code directly via
 * `runInDurableObject` / direct construction; the entrypoint is mostly
 * for the boot step).
 */
export { HmrDurableObject } from "@astroflare/host-cloudflare";

export default {
	async fetch(_req: Request): Promise<Response> {
		return new Response("astroflare workerd test harness");
	},
} satisfies ExportedHandler;
