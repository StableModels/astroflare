/**
 * Runtime tests, executed inside workerd via vitest-pool-workers.
 *
 * Why this layer? `@astroflare/runtime/internal` runs *inside workerd* in
 * production — every page render in dev or prod evaluates `$render`,
 * `$component`, etc. there. Layer A (Node) tests cover the same surface, so
 * this isn't redundant: it catches Node/workerd behavior divergence in the
 * runtime APIs we depend on (Web Crypto, TextEncoder, async iterators,
 * Promise scheduling, etc.).
 *
 * Note: we deliberately avoid dynamic `import()` of data URLs here. vite-node
 * (which sits inside vitest-pool-workers' worker) intercepts those imports
 * and tries to resolve the data URL as a relative path through its module
 * fallback service. That's what blocked the original Phase 2.5 plan to run
 * compiled `.astro` output in this pool — see Phase 2.5 retrospective for the
 * full architectural note. Static imports work fine, so all assertions below
 * call the runtime API directly.
 */
import {
	$attrPair,
	$component,
	$defineVars,
	$escape,
	$hydrationMarker,
	$rawHtml,
	$render,
	$renderComponent,
	$renderSlot,
	$spreadAttrs,
	type AstroComponent,
	isRawHtml,
	renderToString,
} from "@astroflare/runtime/internal";
import { describe, expect, it } from "vitest";

describe("runtime under workerd: $escape", () => {
	it("escapes the standard 5 HTML metacharacters identically to Node", () => {
		expect($escape('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
	});

	it("normalises null/undefined/false/true the same way", () => {
		expect($escape(null)).toBe("");
		expect($escape(undefined)).toBe("");
		expect($escape(false)).toBe("");
		expect($escape(true)).toBe("true");
	});

	it("passes through RawHtml", () => {
		expect($escape($rawHtml("<b>raw</b>"))).toBe("<b>raw</b>");
	});
});

describe("runtime under workerd: $render", () => {
	it("returns a RawHtml marker", async () => {
		const r = await $render`<p>hello</p>`;
		expect(isRawHtml(r)).toBe(true);
		expect(r.html).toBe("<p>hello</p>");
	});

	it("escapes interpolated primitives", async () => {
		const r = await $render`<p>${"<b>x</b>"}</p>`;
		expect(r.html).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>");
	});

	it("does not double-escape nested $render results", async () => {
		const inner = await $render`<b>${"safe"}</b>`;
		const outer = await $render`<p>${inner}</p>`;
		expect(outer.html).toBe("<p><b>safe</b></p>");
	});

	it("awaits Promises", async () => {
		const r = await $render`<p>${Promise.resolve("hi")}</p>`;
		expect(r.html).toBe("<p>hi</p>");
	});

	it("flattens arrays", async () => {
		const r = await $render`${[1, 2, 3]}`;
		expect(r.html).toBe("123");
	});
});

describe("runtime under workerd: $component + slots", () => {
	it("invokes a component and routes slots", async () => {
		const Layout: AstroComponent<{ title: string }> = $component(
			async ({ title }, $$slots) =>
				$render`<header>${title}: ${await $renderSlot($$slots, "title")}</header><main>${await $renderSlot($$slots, "default")}</main>`,
		);
		const r = await $renderComponent(
			Layout,
			{ title: "Home" },
			{
				title: () => $render`<h1>Hi</h1>`,
				default: () => $render`<p>body</p>`,
			},
		);
		expect(r.html).toBe("<header>Home: <h1>Hi</h1></header><main><p>body</p></main>");
	});

	it("falls back when slot is missing", async () => {
		const r = await $renderSlot({}, "default", () => $render`(empty)`);
		expect(r.html).toBe("(empty)");
	});
});

describe("runtime under workerd: attribute helpers", () => {
	it("$attrPair handles every shape", () => {
		expect($attrPair("href", "/x").html).toBe(' href="/x"');
		expect($attrPair("disabled", true).html).toBe(" disabled");
		expect($attrPair("data-x", null).html).toBe("");
		expect($attrPair("title", '<>"&').html).toBe(' title="&lt;&gt;&quot;&amp;"');
	});

	it("$spreadAttrs skips falsy values", () => {
		expect($spreadAttrs({ a: 1, b: null, c: false, d: "x", e: true }).html).toBe(' a="1" d="x" e');
	});

	it("$defineVars emits JSON-encoded const declarations", () => {
		expect($defineVars({ user: { id: 7 } }).html).toBe('const user = {"id":7};');
	});

	it("$hydrationMarker emits a placeholder comment", () => {
		expect($hydrationMarker({ mode: "load" }).html).toBe("<!-- astroflare:hydration mode=load -->");
	});
});

describe("runtime under workerd: renderToString", () => {
	it("flattens any value to a string", async () => {
		expect(await renderToString(null)).toBe("");
		expect(await renderToString("<b>")).toBe("&lt;b&gt;");
		expect(await renderToString($rawHtml("<b>"))).toBe("<b>");
		expect(await renderToString(await $render`<p>${"x"}</p>`)).toBe("<p>x</p>");
	});
});

describe("runtime under workerd: workerd-vs-Node sanity", () => {
	it("Web Crypto is present (`@astroflare/core` content hashing depends on it)", () => {
		expect(typeof globalThis.crypto.subtle.digest).toBe("function");
	});

	it("TextEncoder is global (used by content hashing)", () => {
		expect(typeof TextEncoder).toBe("function");
		expect(new TextEncoder().encode("a")).toBeInstanceOf(Uint8Array);
	});

	it("structuredClone exists (Workers global)", () => {
		expect(typeof structuredClone).toBe("function");
	});
});
