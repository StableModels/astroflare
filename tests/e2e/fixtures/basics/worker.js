// Pre-rendered fixture for the `basics` e2e test. Two routes — `/`
// renders the home page (with a scoped-style hash) and `/about`
// renders the about page.
const HOME =
	"<html><head><title>Basics</title></head>" +
	'<body data-aflare-h="abcd1234"><h1 data-aflare-h="abcd1234">Basics</h1>' +
	'<a href="/about">about</a>' +
	'<style data-aflare-h="abcd1234">[data-aflare-h="abcd1234"] h1 { color: rebeccapurple; }</style>' +
	"</body></html>";
const ABOUT = "<html><head><title>About</title></head><body><p>About page.</p></body></html>";

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/") {
			return new Response(HOME, {
				status: 200,
				headers: { "content-type": "text/html;charset=utf-8" },
			});
		}
		if (url.pathname === "/about") {
			return new Response(ABOUT, {
				status: 200,
				headers: { "content-type": "text/html;charset=utf-8" },
			});
		}
		return new Response("Not found", { status: 404 });
	},
};
