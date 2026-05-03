/**
 * Test worker entrypoint for the Layer-B (workerd-pool) project.
 *
 * Phase 26b: no Astroflare-owned DO classes to register here. The
 * project's tests exercise the framework's compiler + runtime + the
 * Worker Loader binding directly; they don't need DO bindings.
 */

export default {
	async fetch(_req: Request): Promise<Response> {
		return new Response("astroflare workerd test harness");
	},
} satisfies ExportedHandler;
