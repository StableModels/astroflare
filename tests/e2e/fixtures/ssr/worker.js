// SSR fixture for the e2e suite — `/api/echo` echoes search params
// back as JSON; `/` returns a 200 health-check sentinel so
// `aflare e2e status` (which HEADs `/`) reports green.
export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/") {
			return new Response("ssr fixture ready", { status: 200 });
		}
		if (url.pathname === "/api/echo") {
			const params = {};
			for (const [k, v] of url.searchParams) params[k] = v;
			return new Response(JSON.stringify({ params, time: Date.now() }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("Not found", { status: 404 });
	},
};
