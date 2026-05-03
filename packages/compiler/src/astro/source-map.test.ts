import { describe, expect, it } from "vitest";
import { buildLineMap, inlineSourceMappingURL } from "./source-map.js";

describe("buildLineMap", () => {
	it("emits a v3 sourcemap with the source filename", () => {
		const m = buildLineMap("a;\nb;\n", "raw source", "/src/pages/index.astro");
		expect(m.version).toBe(3);
		expect(m.sources).toEqual(["/src/pages/index.astro"]);
		expect(m.sourcesContent?.[0]).toBe("raw source");
		expect(m.file).toBe("index.js");
	});

	it("emits one mapping per generated line, separated by `;`", () => {
		const m = buildLineMap("a;\nb;\nc;\n", "x", "/x.astro");
		expect(m.mappings.split(";").length).toBe(3);
	});

	it("sets sourcesContent to the original source", () => {
		const src = "---\nconst x = 1;\n---\n<p>{x}</p>";
		const m = buildLineMap("compiled", src, "/p.astro");
		expect(m.sourcesContent?.[0]).toBe(src);
	});
});

describe("inlineSourceMappingURL", () => {
	it("returns a base64 data: URL comment", () => {
		const m = buildLineMap("a;", "x", "/x.astro");
		const url = inlineSourceMappingURL(m);
		expect(url).toMatch(
			/^\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,[A-Za-z0-9+/=]+\n$/,
		);
	});
});
