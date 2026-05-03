import { describe, expect, it } from "vitest";
import {
	MOUNT_REACT_ISLAND_SOURCE,
	findDefaultExport,
	wrapReactIslandSource,
} from "./react-adapter.js";

describe("findDefaultExport", () => {
	it("detects `export default function`", () => {
		const r = findDefaultExport("export default function Foo(){}");
		expect(r.found && r.kind).toBe("expr");
	});

	it("detects `export default class`", () => {
		const r = findDefaultExport("export default class Foo{}");
		expect(r.found && r.kind).toBe("expr");
	});

	it("detects `export default <name>`", () => {
		const r = findDefaultExport("function Foo(){}\nexport default Foo;");
		expect(r.found && r.kind).toBe("expr");
	});

	it("detects `export default <expr>`", () => {
		const r = findDefaultExport("export default () => null;");
		expect(r.found && r.kind).toBe("expr");
	});

	it("detects esbuild-normalised `export { X as default }`", () => {
		const r = findDefaultExport(
			"function Counter(props) { return null; }\nexport { Counter as default };",
		);
		expect(r.found).toBe(true);
		if (r.found && r.kind === "alias") {
			expect(r.name).toBe("Counter");
		} else {
			throw new Error("expected alias detection");
		}
	});

	it("returns false when there is no default export", () => {
		expect(findDefaultExport("export const x = 1;").found).toBe(false);
		expect(findDefaultExport("function mount(el, props) {}").found).toBe(false);
	});

	it("ignores indented occurrences inside strings/expressions (line-anchored)", () => {
		// The match pattern is line-anchored, so an `export default` inside
		// a comment or template literal at the start of a line still hits.
		// We accept that limitation — it's consistent with the inline
		// bundler's pragmatic detection.
		expect(findDefaultExport("// export default x").found).toBe(false);
	});
});

describe("wrapReactIslandSource", () => {
	it("returns source unchanged when no default export", () => {
		const src = "export const x = 1;\nexport function mount() {}\n";
		expect(wrapReactIslandSource(src)).toBe(src);
	});

	it("wraps `export default function` with adapter import + mount", () => {
		const src = "export default function Counter(props){ return null; }";
		const out = wrapReactIslandSource(src);
		expect(out).toContain('import { mountReactIsland as __aflareMount } from "/_aflare/react.js"');
		expect(out).toContain("const __aflareDefault = function Counter(props)");
		expect(out).toContain("export default __aflareDefault;");
		expect(out).toContain("export function mount(__el, __props)");
		expect(out).toContain("return __aflareMount(__aflareDefault, __el, __props);");
	});

	it("wraps `export default class`", () => {
		const out = wrapReactIslandSource("export default class C extends Component {}");
		expect(out).toContain("const __aflareDefault = class C extends Component {}");
		expect(out).toContain("export default __aflareDefault;");
	});

	it("wraps `export default <name>;` (bare reference)", () => {
		const out = wrapReactIslandSource(
			"function Counter(props){ return null; }\nexport default Counter;",
		);
		expect(out).toContain("const __aflareDefault = Counter;");
	});

	it("preserves leading indentation when present", () => {
		const out = wrapReactIslandSource("  export default Foo;");
		expect(out).toContain("  const __aflareDefault = Foo;");
	});

	it("does not produce two `export default` statements", () => {
		const out = wrapReactIslandSource("export default Foo;");
		const matches = out.match(/^\s*export\s+default\s+/gm) ?? [];
		// Only the synthetic re-export remains.
		expect(matches).toHaveLength(1);
	});

	it("wraps the esbuild-normalised `export { X as default }` form", () => {
		const src = "function Counter(props) { return null; }\nexport { Counter as default };\n";
		const out = wrapReactIslandSource(src);
		// The original alias `export { Counter as default }` is stripped
		// — wrapping uses `export default __aflareDefault` instead.
		expect(out).not.toContain("export { Counter as default }");
		expect(out).toContain("function Counter(props)");
		expect(out).toContain("const __aflareDefault = Counter;");
		expect(out).toContain("export default __aflareDefault;");
		expect(out).toContain("export function mount(__el, __props)");
	});
});

describe("MOUNT_REACT_ISLAND_SOURCE", () => {
	it("references React, ReactDOMClient.createRoot, and exports mountReactIsland", () => {
		expect(MOUNT_REACT_ISLAND_SOURCE).toContain("export function mountReactIsland");
		expect(MOUNT_REACT_ISLAND_SOURCE).toContain("createRoot(el)");
		expect(MOUNT_REACT_ISLAND_SOURCE).toContain("React.createElement(Component");
	});

	it("default-resolves React from esm.sh (overridable via route)", () => {
		expect(MOUNT_REACT_ISLAND_SOURCE).toContain("https://esm.sh/react@");
		expect(MOUNT_REACT_ISLAND_SOURCE).toContain("https://esm.sh/react-dom@");
	});
});
