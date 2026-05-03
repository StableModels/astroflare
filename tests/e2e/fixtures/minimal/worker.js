// Pre-rendered fixture for the `minimal` e2e test. Each `e2e.spec.ts`
// asserts what should come out the other end; the Worker just serves
// that markup. When the framework's deploy pipeline matures (Phase
// 20b — bundle Astroflare itself for fixtures) this fixture-specific
// worker.js is replaced by the framework-built bundle.
const HTML =
	"<html><head><title>aflare-e2e minimal</title></head><body><h1>Hello, edge</h1></body></html>";

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/") {
			return new Response(HTML, {
				status: 200,
				headers: { "content-type": "text/html;charset=utf-8" },
			});
		}
		return new Response("Not found", { status: 404 });
	},
};
