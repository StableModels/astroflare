import { contentId } from "@astroflare/core";
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./memory-storage.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
	const out: string[] = [];
	for await (const x of iter) out.push(x);
	return out;
}

describe("MemoryStorage", () => {
	describe("file keyspace round-trip", () => {
		it("read returns what write wrote", async () => {
			const s = new MemoryStorage();
			await s.write("/a.txt", enc("hello"));
			expect(dec(await s.read("/a.txt"))).toBe("hello");
		});

		it("read throws for missing files", async () => {
			const s = new MemoryStorage();
			await expect(s.read("/missing")).rejects.toThrow(/not found/);
		});

		it("write is defensive against caller mutation", async () => {
			const s = new MemoryStorage();
			const buf = enc("v1");
			await s.write("/a", buf);
			buf[0] = 0xff; // mutate after write
			expect(dec(await s.read("/a"))).toBe("v1");
		});

		it("remove drops files", async () => {
			const s = new MemoryStorage();
			await s.write("/a", enc("x"));
			await s.remove("/a");
			expect(await s.stat("/a")).toBeNull();
			await expect(s.read("/a")).rejects.toThrow();
		});

		it("remove is a no-op on missing files", async () => {
			const s = new MemoryStorage();
			await expect(s.remove("/missing")).resolves.toBeUndefined();
		});
	});

	describe("cache subspace isolation (§5.2)", () => {
		it("cacheWrite does not affect read()", async () => {
			const s = new MemoryStorage();
			await s.cacheWrite("hash1", enc("cached-bytes"));
			await expect(s.read("hash1")).rejects.toThrow();
			expect(await s.stat("hash1")).toBeNull();
		});

		it("write does not affect cacheRead()", async () => {
			const s = new MemoryStorage();
			await s.write("/foo", enc("file-bytes"));
			expect(await s.cacheRead("/foo")).toBeNull();
		});

		it("cacheRead returns null on miss", async () => {
			const s = new MemoryStorage();
			expect(await s.cacheRead("never-written")).toBeNull();
		});

		it("cache is content-addressed (idempotent)", async () => {
			const s = new MemoryStorage();
			await s.cacheWrite("h", enc("a"));
			await s.cacheWrite("h", enc("a")); // idempotent re-write
			const got = await s.cacheRead("h");
			expect(got).not.toBeNull();
			expect(dec(got as Uint8Array)).toBe("a");
		});
	});

	describe("glob", () => {
		it("matches simple patterns", async () => {
			const s = new MemoryStorage();
			await s.write("/src/pages/index.astro", enc(""));
			await s.write("/src/pages/about.astro", enc(""));
			await s.write("/src/pages/posts/one.md", enc(""));
			await s.write("/src/components/Foo.astro", enc(""));

			expect(await collect(s.glob("/src/pages/*.astro"))).toEqual([
				"/src/pages/about.astro",
				"/src/pages/index.astro",
			]);
		});

		it("matches double-star recursively", async () => {
			const s = new MemoryStorage();
			await s.write("/a/x.md", enc(""));
			await s.write("/a/b/y.md", enc(""));
			await s.write("/a/b/c/z.md", enc(""));

			expect(await collect(s.glob("/a/**/*.md"))).toEqual(["/a/b/c/z.md", "/a/b/y.md", "/a/x.md"]);
		});

		it("returns no results when nothing matches", async () => {
			const s = new MemoryStorage();
			await s.write("/a", enc(""));
			expect(await collect(s.glob("/never/**/*.tsx"))).toEqual([]);
		});
	});

	describe("stat", () => {
		it("returns null for missing files", async () => {
			expect(await new MemoryStorage().stat("/x")).toBeNull();
		});

		it("returns size and content-addressed hash", async () => {
			const s = new MemoryStorage();
			await s.write("/a", enc("hello world"));
			const stat = await s.stat("/a");
			const expected = await contentId(enc("hello world"));
			expect(stat).toEqual({ size: 11, hash: expected });
		});

		it("hash changes when content changes", async () => {
			const s = new MemoryStorage();
			await s.write("/a", enc("v1"));
			const a = await s.stat("/a");
			await s.write("/a", enc("v2"));
			const b = await s.stat("/a");
			expect(a?.hash).not.toBe(b?.hash);
		});
	});
});
