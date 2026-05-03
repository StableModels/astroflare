import { type TestHost, createTestHost } from "@astroflare/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { loadMiddleware, sequence } from "./middleware.js";

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

const ctx = () => ({
	request: new Request("https://app/"),
	url: new URL("https://app/"),
	params: {},
	locals: {} as Record<string, unknown>,
});

describe("loadMiddleware", () => {
	it("returns null when no middleware file exists", async () => {
		const host = await fixture({});
		expect(await loadMiddleware(host, "mw:1")).toBeNull();
	});

	it("loads `onRequest` and runs the chain", async () => {
		const host = await fixture({
			"/src/middleware.js":
				"export const onRequest = async (ctx, next) => { ctx.locals.touched = true; const r = await next(); return r; };",
		});
		const fn = await loadMiddleware(host, "mw:2");
		if (!fn) throw new Error("expected middleware");

		const c = ctx();
		const inner = async () => new Response("ok");
		const r = await fn(c, inner);
		expect(r.status).toBe(200);
		expect(c.locals.touched).toBe(true);
	});

	it("falls back to default export when onRequest absent", async () => {
		const host = await fixture({
			"/src/middleware.js":
				"export default async (ctx, next) => { ctx.locals.via = 'default'; return next(); };",
		});
		const fn = await loadMiddleware(host, "mw:3");
		if (!fn) throw new Error("expected middleware");

		const c = ctx();
		await fn(c, async () => new Response("x"));
		expect(c.locals.via).toBe("default");
	});

	it("middleware can short-circuit by returning a Response without calling next", async () => {
		const host = await fixture({
			"/src/middleware.js":
				"export const onRequest = async () => new Response('blocked', { status: 403 });",
		});
		const fn = await loadMiddleware(host, "mw:4");
		if (!fn) throw new Error("expected middleware");

		let innerCalled = false;
		const r = await fn(ctx(), async () => {
			innerCalled = true;
			return new Response("inner");
		});
		expect(r.status).toBe(403);
		expect(innerCalled).toBe(false);
	});
});

describe("sequence", () => {
	it("runs each middleware in order, threading next() through them", async () => {
		const order: string[] = [];
		const a = async (_c: unknown, next: () => Promise<Response>) => {
			order.push("a-pre");
			const r = await next();
			order.push("a-post");
			return r;
		};
		const b = async (_c: unknown, next: () => Promise<Response>) => {
			order.push("b-pre");
			const r = await next();
			order.push("b-post");
			return r;
		};
		const combined = sequence(
			a as unknown as Parameters<typeof sequence>[0],
			b as unknown as Parameters<typeof sequence>[0],
		);
		await combined(ctx(), async () => {
			order.push("inner");
			return new Response("");
		});
		expect(order).toEqual(["a-pre", "b-pre", "inner", "b-post", "a-post"]);
	});

	it("first middleware can short-circuit and skip the second", async () => {
		let bCalled = false;
		const a = async () => new Response("short", { status: 401 });
		const b = async (_c: unknown, next: () => Promise<Response>) => {
			bCalled = true;
			return next();
		};
		const combined = sequence(
			a as unknown as Parameters<typeof sequence>[0],
			b as unknown as Parameters<typeof sequence>[0],
		);
		const r = await combined(ctx(), async () => new Response("inner"));
		expect(r.status).toBe(401);
		expect(bCalled).toBe(false);
	});
});
