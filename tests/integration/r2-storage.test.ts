/**
 * `R2Storage` unit tests under Miniflare's R2 emulation.
 *
 * Covers the Storage interface contract end-to-end against real R2:
 *   - read / write / remove round-trips
 *   - stat returns SHA from custom metadata fast-path
 *   - glob applies the literal-prefix optimization + regex post-filter
 *   - cache subspace stays disjoint from the files subspace
 */

import { env } from "cloudflare:test";
import { R2Storage } from "@astroflare/host-cloudflare";
import { afterEach, describe, expect, it } from "vitest";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = new TextDecoder();

afterEach(async () => {
	// Wipe between tests — singleWorker pool means we share the bucket.
	let cursor: string | undefined;
	while (true) {
		const r: R2Objects = await env.FILES.list({ cursor });
		await Promise.all(r.objects.map((o) => env.FILES.delete(o.key)));
		if (!r.truncated) break;
		cursor = r.cursor;
	}
});

describe("R2Storage: file keyspace", () => {
	it("round-trips bytes through write / read", async () => {
		const s = new R2Storage({ bucket: env.FILES });
		await s.write("/a.txt", enc("hello"));
		const out = await s.read("/a.txt");
		expect(dec.decode(out)).toBe("hello");
	});

	it("read throws on a missing path", async () => {
		const s = new R2Storage({ bucket: env.FILES });
		await expect(s.read("/nope.txt")).rejects.toThrow(/not found/);
	});

	it("remove deletes the key", async () => {
		const s = new R2Storage({ bucket: env.FILES });
		await s.write("/x.txt", enc("x"));
		await s.remove("/x.txt");
		expect(await s.stat("/x.txt")).toBeNull();
	});

	it("stat returns size + hash via custom metadata fast-path", async () => {
		const s = new R2Storage({ bucket: env.FILES });
		await s.write("/x.txt", enc("hi"));
		const stat = await s.stat("/x.txt");
		expect(stat?.size).toBe(2);
		expect(stat?.hash).toMatch(/^[a-f0-9]+$/);
	});

	it("stat returns null for a missing path", async () => {
		const s = new R2Storage({ bucket: env.FILES });
		expect(await s.stat("/nope.txt")).toBeNull();
	});

	it("stat falls back to fetching bytes when metadata is missing", async () => {
		// Simulate an externally-uploaded file (no aflare-sha metadata).
		await env.FILES.put("files/external.txt", enc("plain bytes"));
		const s = new R2Storage({ bucket: env.FILES });
		const stat = await s.stat("/external.txt");
		expect(stat?.size).toBe("plain bytes".length);
		expect(stat?.hash).toMatch(/^[a-f0-9]+$/);
	});
});

describe("R2Storage: glob", () => {
	it("uses the literal prefix to bound R2 LIST + regex-filters results", async () => {
		const s = new R2Storage({ bucket: env.FILES });
		await s.write("/src/pages/a.astro", enc("a"));
		await s.write("/src/pages/sub/b.astro", enc("b"));
		await s.write("/src/pages/c.md", enc("c"));
		await s.write("/other.txt", enc("d"));

		const found: string[] = [];
		for await (const p of s.glob("/src/pages/**/*.astro")) found.push(p);
		expect(found.sort()).toEqual(["/src/pages/a.astro", "/src/pages/sub/b.astro"]);
	});

	it("yields nothing when no file matches", async () => {
		const s = new R2Storage({ bucket: env.FILES });
		await s.write("/x.txt", enc("x"));
		const found: string[] = [];
		for await (const p of s.glob("/src/pages/**/*.astro")) found.push(p);
		expect(found).toEqual([]);
	});
});

describe("R2Storage: cache keyspace", () => {
	it("cacheRead returns null on miss, bytes on hit", async () => {
		const s = new R2Storage({ bucket: env.FILES });
		expect(await s.cacheRead("missing")).toBeNull();
		await s.cacheWrite("h1", enc("payload"));
		const got = await s.cacheRead("h1");
		expect(got && dec.decode(got)).toBe("payload");
	});

	it("cache keys don't appear in the files glob", async () => {
		const s = new R2Storage({ bucket: env.FILES });
		await s.cacheWrite("hash-only", enc("c"));
		const found: string[] = [];
		// Match everything in the files keyspace.
		for await (const p of s.glob("/**/*")) found.push(p);
		expect(found).toEqual([]);
	});

	it("cacheWrite is idempotent for the same hash", async () => {
		const s = new R2Storage({ bucket: env.FILES });
		await s.cacheWrite("h", enc("x"));
		await s.cacheWrite("h", enc("x"));
		const got = await s.cacheRead("h");
		expect(got && dec.decode(got)).toBe("x");
	});
});
