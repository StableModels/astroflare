import { describe, expect, it } from "vitest";
import { contentId, contentIdWithConfig, sha256Hex, stableStringify } from "./hash.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("hash", () => {
	it("sha256Hex matches a known vector", async () => {
		// SHA-256 of the empty string.
		expect(await sha256Hex("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	it("sha256Hex accepts bytes and strings interchangeably", async () => {
		const a = await sha256Hex("hello");
		const b = await sha256Hex(enc("hello"));
		expect(a).toBe(b);
	});

	it("contentId is the first 16 chars of the full SHA-256 hex (§9.4)", async () => {
		const full = await sha256Hex("hello");
		expect(await contentId("hello")).toBe(full.slice(0, 16));
	});

	it("contentId is deterministic", async () => {
		expect(await contentId("hello")).toBe(await contentId("hello"));
	});

	it("contentId differs for different inputs", async () => {
		expect(await contentId("a")).not.toBe(await contentId("b"));
	});

	it("contentIdWithConfig changes when config changes (§9.4 invalidation rule)", async () => {
		const a = await contentIdWithConfig("source", { compiler: "0.0.0" });
		const b = await contentIdWithConfig("source", { compiler: "0.0.1" });
		expect(a).not.toBe(b);
	});

	it("contentIdWithConfig is stable across key reordering", async () => {
		const a = await contentIdWithConfig("s", { x: 1, y: 2 });
		const b = await contentIdWithConfig("s", { y: 2, x: 1 });
		expect(a).toBe(b);
	});
});

describe("stableStringify", () => {
	it("sorts keys at every level", () => {
		expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
	});

	it("preserves array order", () => {
		expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
	});

	it("handles null and primitives", () => {
		expect(stableStringify(null)).toBe("null");
		expect(stableStringify(42)).toBe("42");
		expect(stableStringify("x")).toBe('"x"');
	});
});
