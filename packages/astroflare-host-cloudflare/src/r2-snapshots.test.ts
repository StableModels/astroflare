import type { SnapshotEntry } from "@astroflare/core";
import { describe, expect, it } from "vitest";
import { R2SnapshotSink, R2Snapshots } from "./r2-snapshots.js";

/**
 * Tiny in-memory `R2Bucket` mock — covers the `get` / `put` / `list`
 * subset `R2Snapshots` and `R2SnapshotSink` exercise.
 */
function makeMockR2(): R2Bucket {
	type Stored = {
		bytes: Uint8Array;
		contentType?: string;
	};
	const objects = new Map<string, Stored>();

	const bucket: R2Bucket = {
		async get(key: string) {
			const obj = objects.get(key);
			if (!obj) return null;
			const bytes = obj.bytes;
			return {
				key,
				size: bytes.byteLength,
				etag: "etag",
				httpEtag: "etag",
				uploaded: new Date(),
				version: "v",
				checksums: {} as R2Checksums,
				httpMetadata: { contentType: obj.contentType },
				customMetadata: undefined,
				async arrayBuffer() {
					const copy = new Uint8Array(bytes.byteLength);
					copy.set(bytes);
					return copy.buffer;
				},
				async text() {
					return new TextDecoder().decode(bytes);
				},
				async json() {
					return JSON.parse(new TextDecoder().decode(bytes));
				},
				async blob() {
					return new Blob([bytes as unknown as ArrayBuffer]);
				},
				body: null as unknown as ReadableStream,
				bodyUsed: false,
				writeHttpMetadata() {},
			} as unknown as R2ObjectBody;
		},
		async put(
			key: string,
			body: ArrayBuffer | ReadableStream | Uint8Array | string,
			opts?: { httpMetadata?: { contentType?: string } },
		) {
			let bytes: Uint8Array;
			if (body instanceof Uint8Array) bytes = new Uint8Array(body);
			else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
			else if (typeof body === "string") bytes = new TextEncoder().encode(body);
			else throw new Error("unsupported body");
			objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
			return null as unknown as R2Object;
		},
		async list(opts?: { prefix?: string; cursor?: string; limit?: number }) {
			const prefix = opts?.prefix ?? "";
			const keys: string[] = [];
			for (const k of objects.keys()) {
				if (k.startsWith(prefix)) keys.push(k);
			}
			keys.sort();
			return {
				objects: keys.map((k) => ({ key: k })) as unknown as R2Object[],
				truncated: false,
				delimitedPrefixes: [] as string[],
			} as unknown as R2Objects;
		},
		async delete() {},
		async head() {
			return null;
		},
		createMultipartUpload: () => Promise.resolve(null as unknown as R2MultipartUpload),
		resumeMultipartUpload: () => null as unknown as R2MultipartUpload,
	} as unknown as R2Bucket;
	return bucket;
}

function entry(route: string, html: string): SnapshotEntry {
	return {
		route,
		bytes: new TextEncoder().encode(html),
		contentType: "text/html;charset=utf-8",
		hash: `h-${route}`,
	};
}

describe("R2SnapshotSink + R2Snapshots round-trip", () => {
	it("write then read with default prefix (bucket root)", async () => {
		const bucket = makeMockR2();
		const sink = new R2SnapshotSink({ bucket });
		const snapshots = new R2Snapshots({ bucket });

		await sink.put("hashA", entry("/", "<h1>home</h1>"));
		await sink.put("hashA", entry("/about.html", "<h1>about</h1>"));
		await sink.commit("hashA");

		const current = await snapshots.current();
		expect(current).toBe("hashA");

		const root = await snapshots.read("hashA", "/");
		expect(root).not.toBeNull();
		expect(new TextDecoder().decode(root?.bytes as Uint8Array)).toBe("<h1>home</h1>");
		expect(root?.contentType).toBe("text/html;charset=utf-8");
	});

	it("respects prefix for multi-site partitioning", async () => {
		const bucket = makeMockR2();
		const sinkA = new R2SnapshotSink({ bucket, prefix: "sites/abc/" });
		const sinkB = new R2SnapshotSink({ bucket, prefix: "sites/def/" });

		await sinkA.put("h1", entry("/", "site-A"));
		await sinkA.commit("h1");
		await sinkB.put("h2", entry("/", "site-B"));
		await sinkB.commit("h2");

		const snapsA = new R2Snapshots({ bucket, prefix: "sites/abc/" });
		const snapsB = new R2Snapshots({ bucket, prefix: "sites/def/" });

		expect(await snapsA.current()).toBe("h1");
		expect(await snapsB.current()).toBe("h2");

		const aRoot = await snapsA.read("h1", "/");
		const bRoot = await snapsB.read("h2", "/");
		expect(new TextDecoder().decode(aRoot?.bytes as Uint8Array)).toBe("site-A");
		expect(new TextDecoder().decode(bRoot?.bytes as Uint8Array)).toBe("site-B");

		// Cross-reads return null — prefix isolation works.
		expect(await snapsA.read("h2", "/")).toBeNull();
	});

	it("normalises a prefix without trailing slash", async () => {
		const bucket = makeMockR2();
		const sink = new R2SnapshotSink({ bucket, prefix: "sites/abc" });
		const snapshots = new R2Snapshots({ bucket, prefix: "sites/abc" });

		await sink.put("h1", entry("/", "x"));
		await sink.commit("h1");
		expect(await snapshots.current()).toBe("h1");
	});

	it("list returns committed snapshot hashes", async () => {
		const bucket = makeMockR2();
		const sink = new R2SnapshotSink({ bucket });

		await sink.put("h1", entry("/", "v1"));
		await sink.commit("h1");
		await sink.put("h2", entry("/", "v2"));
		await sink.commit("h2");

		const snapshots = new R2Snapshots({ bucket });
		const list = await snapshots.list();
		expect(list).toEqual(["h1", "h2"]);
	});
});
