import { describe, expect, it } from "vitest";
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
} from "./internal.js";

describe("$escape", () => {
	it("escapes the standard 5 HTML metacharacters", () => {
		expect($escape("<a href=\"x\" data-x='y'>&</a>")).toBe(
			"&lt;a href=&quot;x&quot; data-x=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
		);
	});

	it("converts null/undefined/false to empty", () => {
		expect($escape(null)).toBe("");
		expect($escape(undefined)).toBe("");
		expect($escape(false)).toBe("");
	});

	it("passes through RawHtml unescaped", () => {
		expect($escape($rawHtml("<b>raw</b>"))).toBe("<b>raw</b>");
	});
});

describe("$render", () => {
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
		const r = await $render`<ul>${[1, 2, 3].map((n) => `<li>${n}</li>`)}</ul>`;
		// Strings inside array are still strings → escaped.
		expect(r.html).toBe(
			"<ul>&lt;li&gt;1&lt;/li&gt;&lt;li&gt;2&lt;/li&gt;&lt;li&gt;3&lt;/li&gt;</ul>",
		);
	});

	it("treats false/null/undefined as empty", async () => {
		const r = await $render`<p>${null}${false}${undefined}</p>`;
		expect(r.html).toBe("<p></p>");
	});

	it('treats true as the literal string "true"', async () => {
		const r = await $render`<p>${true}</p>`;
		expect(r.html).toBe("<p>true</p>");
	});
});

describe("$component", () => {
	it("tags the function so callers can detect components", () => {
		const C = $component(async () => "x");
		expect((C as unknown as { __astroComponent: true }).__astroComponent).toBe(true);
	});

	it("invokes the user's function with props and slots", async () => {
		const C = $component<{ name: string }>(async ({ name }, slots) => {
			expect(name).toBe("world");
			expect(slots).toEqual({});
			return $render`<p>${name}</p>`;
		});
		const r = await C({ name: "world" }, {});
		expect(r.html).toBe("<p>world</p>");
	});

	it("coerces non-RawHtml returns into a RawHtml marker", async () => {
		const C = $component(async () => "<plain>text</plain>");
		const r = await C({}, {});
		expect(isRawHtml(r)).toBe(true);
		// The plain string was treated as a value to flatten — so it gets escaped.
		expect(r.html).toBe("&lt;plain&gt;text&lt;/plain&gt;");
	});
});

describe("$renderComponent", () => {
	it("invokes the component's function and forwards the result", async () => {
		const C: AstroComponent<{ x: number }> = $component(async ({ x }) => $render`<i>${x}</i>`);
		const r = await $renderComponent(C, { x: 7 });
		expect(r.html).toBe("<i>7</i>");
	});

	it("throws on a non-component value", async () => {
		await expect(
			$renderComponent({} as unknown as AstroComponent<unknown>, {}, {}),
		).rejects.toThrow(/expected a component/);
	});
});

describe("$renderSlot", () => {
	it("invokes the named slot if present", async () => {
		const r = await $renderSlot({ default: () => $render`<p>hi</p>` });
		expect(r.html).toBe("<p>hi</p>");
	});

	it("falls back if the slot is missing", async () => {
		const r = await $renderSlot({}, "default", () => $render`<em>none</em>`);
		expect(r.html).toBe("<em>none</em>");
	});

	it("returns empty when neither slot nor fallback exists", async () => {
		const r = await $renderSlot({}, "missing");
		expect(r.html).toBe("");
	});

	it("looks up named slots", async () => {
		const r = await $renderSlot({ aside: () => $render`<aside />` }, "aside");
		expect(r.html).toBe("<aside />");
	});
});

describe("$attrPair", () => {
	it('emits ` name="value"` for a normal value', () => {
		const r = $attrPair("href", "/x");
		expect(r.html).toBe(' href="/x"');
	});

	it("emits just ` name` for boolean true", () => {
		const r = $attrPair("disabled", true);
		expect(r.html).toBe(" disabled");
	});

	it("emits empty string for null / false / undefined", () => {
		expect($attrPair("data-x", null).html).toBe("");
		expect($attrPair("data-x", false).html).toBe("");
		expect($attrPair("data-x", undefined).html).toBe("");
	});

	it("escapes HTML metacharacters in the value", () => {
		const r = $attrPair("title", '"<>&');
		expect(r.html).toBe(' title="&quot;&lt;&gt;&amp;"');
	});
});

describe("$spreadAttrs", () => {
	it("emits each key=value pair, skipping null/undefined/false", () => {
		const r = $spreadAttrs({ a: 1, b: null, c: false, d: "x", e: true });
		expect(r.html).toBe(' a="1" d="x" e');
	});

	it("returns empty for null/undefined inputs", () => {
		expect($spreadAttrs(null).html).toBe("");
		expect($spreadAttrs(undefined).html).toBe("");
	});
});

describe("$rawHtml", () => {
	it("wraps a string", () => {
		const r = $rawHtml("<b>raw</b>");
		expect(isRawHtml(r)).toBe(true);
		expect(r.html).toBe("<b>raw</b>");
	});

	it("returns the same RawHtml passed in", () => {
		const a = $rawHtml("x");
		expect($rawHtml(a)).toBe(a);
	});

	it("treats null/undefined as empty", () => {
		expect($rawHtml(null).html).toBe("");
	});
});

describe("$defineVars", () => {
	it("emits const declarations with JSON values", () => {
		const r = $defineVars({ user: { id: 42 }, n: 3 });
		expect(r.html).toBe('const user = {"id":42};\nconst n = 3;');
	});
});

describe("$hydrationMarker", () => {
	it("emits a comment marker per directive", () => {
		const r = $hydrationMarker({ mode: "load" });
		expect(r.html).toBe("<!-- astroflare:hydration mode=load -->");
	});

	it("includes media for client:media", () => {
		const r = $hydrationMarker({ mode: "media", mediaQuery: "(min-width: 800px)" });
		expect(r.html).toBe('<!-- astroflare:hydration mode=media media="(min-width: 800px)" -->');
	});
});

describe("renderToString", () => {
	it("flattens any value into HTML", async () => {
		expect(await renderToString(null)).toBe("");
		expect(await renderToString("<b>")).toBe("&lt;b&gt;");
		expect(await renderToString($rawHtml("<b>"))).toBe("<b>");
		expect(await renderToString(await $render`<p>${"x"}</p>`)).toBe("<p>x</p>");
	});
});
