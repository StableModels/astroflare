import { type TestHost, createTestHost } from "@astroflare/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { runEndpoint } from "./endpoint.js";

const enc = (s: string) => new TextEncoder().encode(s);

const active: TestHost[] = [];
afterEach(async () => {
	await Promise.all(active.splice(0).map((h) => h.dispose()));
});

async function fixture(files: Record<string, string>): Promise<TestHost> {
	const host = createTestHost();
	active.push(host);
	for (const [p, body] of Object.entries(files)) host.site.write(p, enc(body));
	return host;
}

describe("runEndpoint", () => {
	it("dispatches GET to the named export", async () => {
		const host = await fixture({
			"/src/pages/api/hello.js": 'export const GET = async () => new Response("hello");',
		});
		const r = await runEndpoint({
			host,
			filePath: "/src/pages/api/hello.js",
			cacheId: "ep:1",
			context: {
				request: new Request("https://app/api/hello"),
				url: new URL("https://app/api/hello"),
				params: {},
			},
		});
		expect(r.status).toBe(200);
		expect(await r.text()).toBe("hello");
	});

	it("dispatches POST to the named export", async () => {
		const host = await fixture({
			"/src/pages/api/users.js":
				'export const POST = async () => new Response("created", { status: 201 });',
		});
		const r = await runEndpoint({
			host,
			filePath: "/src/pages/api/users.js",
			cacheId: "ep:2",
			context: {
				request: new Request("https://app/api/users", { method: "POST" }),
				url: new URL("https://app/api/users"),
				params: {},
			},
		});
		expect(r.status).toBe(201);
		expect(await r.text()).toBe("created");
	});

	it("falls back to default export for unmatched methods", async () => {
		const host = await fixture({
			"/src/pages/api/echo.js":
				'export default async ({ request }) => new Response("any:" + request.method);',
		});
		const r = await runEndpoint({
			host,
			filePath: "/src/pages/api/echo.js",
			cacheId: "ep:3",
			context: {
				request: new Request("https://app/api/echo", { method: "DELETE" }),
				url: new URL("https://app/api/echo"),
				params: {},
			},
		});
		expect(await r.text()).toBe("any:DELETE");
	});

	it("returns 405 when method is not handled and no default", async () => {
		const host = await fixture({
			"/src/pages/api/get-only.js": 'export const GET = async () => new Response("ok");',
		});
		const r = await runEndpoint({
			host,
			filePath: "/src/pages/api/get-only.js",
			cacheId: "ep:4",
			context: {
				request: new Request("https://app/api/get-only", { method: "POST" }),
				url: new URL("https://app/api/get-only"),
				params: {},
			},
		});
		expect(r.status).toBe(405);
		expect(r.headers.get("allow")).toContain("GET");
	});

	it("supports `export async function NAME(...)` form", async () => {
		const host = await fixture({
			"/src/pages/api/named.js": "export async function GET() { return new Response('via fn'); }",
		});
		const r = await runEndpoint({
			host,
			filePath: "/src/pages/api/named.js",
			cacheId: "ep:5",
			context: {
				request: new Request("https://app/api/named"),
				url: new URL("https://app/api/named"),
				params: {},
			},
		});
		expect(await r.text()).toBe("via fn");
	});

	it("passes request, url, params through to the handler", async () => {
		const host = await fixture({
			"/src/pages/api/[id].js":
				"export const GET = async ({ params, url }) => new Response(JSON.stringify({ id: params.id, q: url.searchParams.get('q') }));",
		});
		const r = await runEndpoint({
			host,
			filePath: "/src/pages/api/[id].js",
			cacheId: "ep:6",
			context: {
				request: new Request("https://app/api/42?q=hi"),
				url: new URL("https://app/api/42?q=hi"),
				params: { id: "42" },
			},
		});
		expect(await r.text()).toBe('{"id":"42","q":"hi"}');
	});
});
