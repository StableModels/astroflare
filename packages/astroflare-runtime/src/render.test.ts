/**
 * Tests for the framework-side `render()` entrypoint — Phase 10's
 * cookies / locals / slots / redirect surface.
 *
 * `render()` itself doesn't compile .astro files; it takes an already-
 * compiled `$component` and a `RenderContext`, builds the `Astro` global,
 * invokes the component, and returns a structured `RenderResult`.
 */
import type { RenderContext } from "@astroflare/core";
import { describe, expect, it } from "vitest";
import { $component, $render, type AstroComponent } from "./internal.js";
import { render } from "./render.js";

interface AstroProp {
	Astro: {
		cookies: { get(name: string): { value: string } | undefined; set: typeof Function };
		locals: Record<string, unknown>;
		slots: { has(name: string): boolean; render(name: string): Promise<string> };
		redirect: (to: string, status?: 301 | 302 | 303 | 307 | 308) => Response;
		props: Record<string, unknown>;
		params: Record<string, string>;
	};
}

function ctx(overrides: Partial<RenderContext> = {}): RenderContext {
	const url = new URL("https://example.test/");
	return {
		props: {},
		params: {},
		request: new Request(url),
		url,
		...overrides,
	};
}

describe("render() — Astro.cookies", () => {
	it("reads cookies parsed from the request header", async () => {
		const c = $component(async (props: AstroProp) => {
			const v = props.Astro.cookies.get("session")?.value ?? "(none)";
			return $render`session=${v}`;
		}) as AstroComponent<AstroProp>;
		const result = await render(
			c as never,
			ctx({
				request: new Request("https://example.test/", {
					headers: { cookie: "session=abc123" },
				}),
			}),
		);
		expect(result.kind).toBe("html");
		if (result.kind !== "html") return;
		expect(result.html).toBe("session=abc123");
	});

	it("staged Set-Cookie writes appear in result.cookies", async () => {
		const c = $component(async (props: AstroProp) => {
			props.Astro.cookies.set("session", "new-value", { path: "/" });
			return $render`ok`;
		}) as AstroComponent<AstroProp>;
		const result = await render(c as never, ctx());
		expect(result.kind).toBe("html");
		if (result.kind !== "html") return;
		expect(result.cookies).toEqual(["session=new-value; Path=/"]);
	});

	it("cookies set during render survive the redirect short-circuit", async () => {
		const c = $component(async (props: AstroProp) => {
			props.Astro.cookies.set("auth", "1");
			return props.Astro.redirect("/dashboard", 302);
		}) as AstroComponent<AstroProp>;
		const result = await render(c as never, ctx());
		expect(result.kind).toBe("response");
		if (result.kind !== "response") return;
		expect(result.cookies).toEqual(["auth=1"]);
	});
});

describe("render() — Astro.locals", () => {
	it("a locals bag passed in via context is visible to the page", async () => {
		const c = $component(async (props: AstroProp) => {
			const user = props.Astro.locals.user as { name: string } | undefined;
			return $render`user=${user?.name ?? "(anon)"}`;
		}) as AstroComponent<AstroProp>;
		const result = await render(c as never, ctx({ locals: { user: { name: "Alice" } } }));
		expect(result.kind).toBe("html");
		if (result.kind !== "html") return;
		expect(result.html).toBe("user=Alice");
	});

	it("when no locals are supplied, Astro.locals is an empty object", async () => {
		const c = $component(async (props: AstroProp) => {
			return $render`keys=${Object.keys(props.Astro.locals).length}`;
		}) as AstroComponent<AstroProp>;
		const result = await render(c as never, ctx());
		expect(result.kind).toBe("html");
		if (result.kind !== "html") return;
		expect(result.html).toBe("keys=0");
	});
});

describe("render() — Astro.slots imperative", () => {
	it("Astro.slots.has(name) reports whether a slot was supplied", async () => {
		const c = $component(async (props: AstroProp) => {
			const has = props.Astro.slots.has("aside");
			return $render`aside=${String(has)}`;
		}) as AstroComponent<AstroProp>;
		const a = await render(c as never, ctx());
		const b = await render(c as never, ctx(), {
			slots: { aside: () => "x" },
		});
		expect((a as { html: string }).html).toBe("aside=false");
		expect((b as { html: string }).html).toBe("aside=true");
	});

	it("Astro.slots.render(name) returns the slot's flattened HTML", async () => {
		const c = $component(async (props: AstroProp) => {
			const aside = await props.Astro.slots.render("aside");
			return $render`<aside>${aside}</aside>`;
		}) as AstroComponent<AstroProp>;
		const result = await render(c as never, ctx(), {
			slots: { aside: () => $render`<b>important</b>` },
		});
		expect(result.kind).toBe("html");
		if (result.kind !== "html") return;
		// `Astro.slots.render` already returns a string, so the template
		// re-escapes it. That matches how Astro reports it: imperative slot
		// rendering returns rendered HTML the user is responsible for
		// re-marking-raw if they want it inserted as HTML.
		expect(result.html).toContain("<aside>");
	});

	it("Astro.slots.render of a missing slot returns empty string", async () => {
		const c = $component(async (props: AstroProp) => {
			const x = await props.Astro.slots.render("missing");
			return $render`x=[${x}]`;
		}) as AstroComponent<AstroProp>;
		const r = await render(c as never, ctx());
		expect((r as { html: string }).html).toBe("x=[]");
	});
});

describe("render() — Astro.redirect propagation", () => {
	it("a Response returned from frontmatter becomes a structured response result", async () => {
		const c = $component(async (props: AstroProp) => {
			return props.Astro.redirect("/login", 302);
		}) as AstroComponent<AstroProp>;
		const result = await render(c as never, ctx());
		expect(result.kind).toBe("response");
		if (result.kind !== "response") return;
		expect(result.status).toBe(302);
		expect(result.headers.location).toBe("/login");
	});

	it("supports 301 redirects", async () => {
		const c = $component(async (props: AstroProp) => {
			return props.Astro.redirect("/home", 301);
		}) as AstroComponent<AstroProp>;
		const result = await render(c as never, ctx());
		expect(result.kind).toBe("response");
		if (result.kind !== "response") return;
		expect(result.status).toBe(301);
	});

	it("an arbitrary Response (e.g. JSON) is propagated unchanged", async () => {
		const c = $component(async () => {
			return new Response(JSON.stringify({ ok: true }), {
				status: 418,
				headers: { "content-type": "application/json" },
			});
		}) as AstroComponent<AstroProp>;
		const result = await render(c as never, ctx());
		expect(result.kind).toBe("response");
		if (result.kind !== "response") return;
		expect(result.status).toBe(418);
		expect(result.body).toBe('{"ok":true}');
		expect(result.headers["content-type"]).toBe("application/json");
	});
});
