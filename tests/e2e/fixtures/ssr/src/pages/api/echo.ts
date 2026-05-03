/**
 * Phase 20 e2e SSR fixture endpoint. Echoes the URL search params
 * back as JSON. Lets the e2e spec assert dynamic-route behaviour
 * without needing a database or external service.
 */

import type { APIContext } from "@astroflare/core";

export async function GET(ctx: APIContext): Promise<Response> {
	const params: Record<string, string> = {};
	for (const [k, v] of ctx.url.searchParams) params[k] = v;
	return new Response(JSON.stringify({ params, time: Date.now() }), {
		headers: { "content-type": "application/json" },
	});
}
