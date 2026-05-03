import { MemoryStorage } from "@astroflare/test-utils";
import { describe, expect, it } from "vitest";
import { Router, routeFromFilePath } from "./router.js";

describe("routeFromFilePath", () => {
	it("maps /src/pages/index.astro to root /", () => {
		const r = routeFromFilePath("/src/pages/index.astro");
		expect(r?.pattern.test("/")).toBe(true);
		expect(r?.isStatic).toBe(true);
		expect(r?.paramNames).toEqual([]);
	});

	it("maps /src/pages/about.astro to /about", () => {
		const r = routeFromFilePath("/src/pages/about.astro");
		expect(r?.pattern.test("/about")).toBe(true);
		expect(r?.pattern.test("/aboutx")).toBe(false);
	});

	it("maps nested index files to their directory path", () => {
		const r = routeFromFilePath("/src/pages/posts/index.astro");
		expect(r?.pattern.test("/posts")).toBe(true);
	});

	it("maps [slug].astro to a dynamic single-segment route", () => {
		const r = routeFromFilePath("/src/pages/posts/[slug].astro");
		expect(r).not.toBeNull();
		expect(r?.isStatic).toBe(false);
		expect(r?.paramNames).toEqual(["slug"]);
		const m = r?.pattern.exec("/posts/hello-world");
		expect(m?.[1]).toBe("hello-world");
		expect(r?.pattern.test("/posts")).toBe(false);
		expect(r?.pattern.test("/posts/a/b")).toBe(false);
	});

	it("returns null for non-page files", () => {
		expect(routeFromFilePath("/src/components/Foo.astro")).toBeNull();
		expect(routeFromFilePath("/src/pages/_layout.tsx")).toBeNull();
	});

	it("recognises .md as a markdown route (Phase 6)", () => {
		const r = routeFromFilePath("/src/pages/post.md");
		expect(r?.kind).toBe("markdown");
	});

	it("recognises .ts as an endpoint route (Phase 11)", () => {
		const r = routeFromFilePath("/src/pages/api.ts");
		expect(r?.kind).toBe("endpoint");
	});

	it("ignores extensions that aren't yet supported", () => {
		// `.mdx` is deferred to Phase 14.
		expect(routeFromFilePath("/src/pages/post.mdx")).toBeNull();
	});
});

describe("Router.discover + match", () => {
	const enc = (s: string) => new TextEncoder().encode(s);

	async function buildRouter(files: Record<string, string>): Promise<Router> {
		const s = new MemoryStorage();
		for (const [p, body] of Object.entries(files)) await s.write(p, enc(body));
		const r = new Router();
		await r.discover(s);
		return r;
	}

	it("discovers every .astro file under src/pages", async () => {
		const r = await buildRouter({
			"/src/pages/index.astro": "",
			"/src/pages/about.astro": "",
			"/src/pages/posts/[slug].astro": "",
			"/src/components/Foo.astro": "", // ignored
		});
		expect(r.routes).toHaveLength(3);
	});

	it("matches static routes before dynamic", async () => {
		const r = await buildRouter({
			"/src/pages/[slug].astro": "",
			"/src/pages/about.astro": "",
		});
		const m = r.match("/about");
		expect(m?.route.filePath).toBe("/src/pages/about.astro");
	});

	it("falls back to dynamic when no static matches", async () => {
		const r = await buildRouter({
			"/src/pages/[slug].astro": "",
			"/src/pages/about.astro": "",
		});
		const m = r.match("/anything-else");
		expect(m?.route.filePath).toBe("/src/pages/[slug].astro");
		expect(m?.params).toEqual({ slug: "anything-else" });
	});

	it("populates params from dynamic segments", async () => {
		const r = await buildRouter({
			"/src/pages/posts/[id].astro": "",
		});
		const m = r.match("/posts/42");
		expect(m?.params).toEqual({ id: "42" });
	});

	it("decodes URI-encoded path segments", async () => {
		const r = await buildRouter({
			"/src/pages/users/[name].astro": "",
		});
		const m = r.match("/users/jane%20doe");
		expect(m?.params).toEqual({ name: "jane doe" });
	});

	it("tolerates trailing slashes (root excluded)", async () => {
		const r = await buildRouter({
			"/src/pages/about.astro": "",
			"/src/pages/index.astro": "",
		});
		expect(r.match("/about/")?.route.filePath).toBe("/src/pages/about.astro");
		expect(r.match("/")?.route.filePath).toBe("/src/pages/index.astro");
	});

	it("returns null for unmatched pathnames", async () => {
		const r = await buildRouter({ "/src/pages/about.astro": "" });
		expect(r.match("/never")).toBeNull();
	});
});
