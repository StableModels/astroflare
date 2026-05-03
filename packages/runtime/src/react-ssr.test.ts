import { afterEach, describe, expect, it } from "vitest";
import { __resetReactCacheForTests, ssrReactIsland } from "./react-ssr.js";

afterEach(() => {
	__resetReactCacheForTests();
});

describe("ssrReactIsland (Phase 16b)", () => {
	it("renders a function component to a string of HTML", async () => {
		// Use React.createElement directly so this test doesn't need JSX.
		const React = await import("react");
		const Comp = (props: { name: string }) =>
			React.createElement("p", null, `Hello, ${props.name}`);
		const r = await ssrReactIsland(Comp, { name: "edge" });
		expect(r.__astroRaw).toBe(true);
		expect(r.html).toBe("<p>Hello, edge</p>");
	});

	it("renders components that use hooks (useState initial value applies)", async () => {
		const React = await import("react");
		const Counter = (props: { initial: number }) => {
			const [n] = React.useState(props.initial);
			return React.createElement("button", null, `n=${n}`);
		};
		const r = await ssrReactIsland(Counter, { initial: 5 });
		expect(r.html).toBe("<button>n=5</button>");
	});

	it("returns empty raw HTML when the component is not a function", async () => {
		const r = await ssrReactIsland(null);
		expect(r.html).toBe("");
	});

	it("returns empty raw HTML and warns when React's renderToString throws", async () => {
		const React = await import("react");
		const ThrowingComponent = () => {
			throw new Error("boom");
		};
		const r = await ssrReactIsland(ThrowingComponent, {});
		// The SSR path catches the throw and falls back to empty.
		expect(r.html).toBe("");
		// Reuse loaded modules — the next test should see them.
		void React;
	});
});
