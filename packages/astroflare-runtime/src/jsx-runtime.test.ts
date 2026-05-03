import { describe, expect, it } from "vitest";
import { $component, $render, isRawHtml } from "./internal.js";
import { Fragment, jsx, jsxs } from "./jsx-runtime.js";

async function html(value: unknown): Promise<string> {
	if (value == null) return "";
	if (isRawHtml(value)) return value.html;
	throw new Error(`expected RawHtml, got ${typeof value}`);
}

describe("jsx-runtime: HTML elements", () => {
	it("renders a simple element with children", async () => {
		const out = await jsx("h1", { children: "Hello" });
		expect(await html(out)).toBe("<h1>Hello</h1>");
	});

	it("escapes string children", async () => {
		const out = await jsx("p", { children: '<script>alert("x")</script>' });
		expect(await html(out)).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
	});

	it("emits attributes (string and boolean)", async () => {
		const out = await jsx("a", { href: "/x", "aria-current": "page", hidden: true });
		expect(await html(out)).toBe('<a href="/x" aria-current="page" hidden></a>');
	});

	it("drops null / false attributes", async () => {
		const out = await jsx("input", { value: null, disabled: false, type: "text" });
		expect(await html(out)).toContain('type="text"');
		expect(await html(out)).not.toContain("value=");
		expect(await html(out)).not.toContain("disabled");
	});

	it("self-closes void elements", async () => {
		const out = await jsx("br", {});
		expect(await html(out)).toBe("<br />");
	});

	it("maps React-style attribute names (className, htmlFor)", async () => {
		const out = await jsx("label", { className: "lbl", htmlFor: "id-1", children: "x" });
		expect(await html(out)).toBe('<label class="lbl" for="id-1">x</label>');
	});

	it("escapes attribute values", async () => {
		const out = await jsx("a", { href: 'javascript:"evil"' });
		expect(await html(out)).toBe('<a href="javascript:&quot;evil&quot;"></a>');
	});
});

describe("jsx-runtime: children composition", () => {
	it("renders an array of children", async () => {
		const out = await jsxs("ul", {
			children: [await jsx("li", { children: "a" }), await jsx("li", { children: "b" })],
		});
		expect(await html(out)).toBe("<ul><li>a</li><li>b</li></ul>");
	});

	it("Fragment renders only children", async () => {
		const out = await jsx(Fragment, {
			children: [await jsx("h1", { children: "Hi" }), " ", "World"],
		});
		expect(await html(out)).toBe("<h1>Hi</h1> World");
	});

	it("nested arrays flatten correctly", async () => {
		const inner = [
			await jsx("span", { children: "x" }),
			[await jsx("span", { children: "y" }), await jsx("span", { children: "z" })],
		];
		const out = await jsx("div", { children: inner });
		expect(await html(out)).toBe("<div><span>x</span><span>y</span><span>z</span></div>");
	});

	it("primitives render correctly", async () => {
		const out = await jsx("p", { children: [1, 2, " ", "tres"] });
		expect(await html(out)).toBe("<p>12 tres</p>");
	});

	it("null / false children are dropped", async () => {
		const out = await jsx("p", { children: ["a", null, false, "b"] });
		expect(await html(out)).toBe("<p>ab</p>");
	});
});

describe("jsx-runtime: components", () => {
	it("invokes a plain function component", async () => {
		const Greeting = (props: { name: string }) => `Hello, ${props.name}!`;
		const out = await jsx(Greeting, { name: "Ada" });
		expect(await html(out)).toBe("Hello, Ada!");
	});

	it("plain components can return jsx", async () => {
		const Box = async (props: { label: string }) =>
			jsx("div", { className: "box", children: props.label });
		const out = await jsx(Box, { label: "x" });
		expect(await html(out)).toBe('<div class="box">x</div>');
	});

	it("invokes an Astroflare $component with Astro context", async () => {
		const Title = $component<{ Astro: unknown; text: string }>(
			async (props) => $render`<h2>${props.text}</h2>`,
		);
		const out = await jsx(Title, { text: "Welcome" });
		expect(await html(out)).toBe("<h2>Welcome</h2>");
	});

	it("Astroflare component receives `children` as the default slot", async () => {
		const Wrapper = $component<{ Astro: unknown }>(async (_props, slots) => {
			const inner = slots.default ? await slots.default() : "";
			return $render`<section>${inner}</section>`;
		});
		const out = await jsx(Wrapper, {
			children: await jsx("p", { children: "inside" }),
		});
		expect(await html(out)).toBe("<section><p>inside</p></section>");
	});
});
