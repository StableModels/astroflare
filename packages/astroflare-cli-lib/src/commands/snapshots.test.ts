import { describe, expect, it } from "vitest";
import { CLI_ERROR_CODES, isAstroflareCliError } from "../errors.js";
import { snapshotCat, snapshotCurrent, snapshotList } from "./snapshots.js";

function fakeClient(objects: Map<string, { text: string; contentType?: string }>) {
	return {
		async getR2Object({ key }: { bucket: string; key: string }) {
			const obj = objects.get(key);
			if (!obj) return null;
			return { text: obj.text, contentType: obj.contentType ?? null };
		},
		async listR2Objects({ prefix = "" }: { bucket: string; prefix?: string }) {
			const out: { key: string }[] = [];
			for (const k of objects.keys()) {
				if (k.startsWith(prefix)) out.push({ key: k });
			}
			return out;
		},
	} as unknown as Parameters<typeof snapshotList>[0]["client"];
}

describe("snapshotList / snapshotCurrent / snapshotCat", () => {
	it("snapshotList enumerates hashes and marks current", async () => {
		const objects = new Map<string, { text: string }>([
			["h1/index.html", { text: "v1" }],
			["h1/_meta.json", { text: "{}" }],
			["h2/index.html", { text: "v2" }],
			["h2/_meta.json", { text: "{}" }],
			["current", { text: "h2" }],
		]);
		const list = await snapshotList({
			client: fakeClient(objects),
			bucket: "b",
		});
		expect(list).toEqual([
			{ hash: "h1", current: false },
			{ hash: "h2", current: true },
		]);
	});

	it("snapshotList respects prefix", async () => {
		const objects = new Map<string, { text: string }>([
			["sites/abc/h1/index.html", { text: "v1" }],
			["sites/abc/current", { text: "h1" }],
			["sites/def/h2/index.html", { text: "v2" }],
			["sites/def/current", { text: "h2" }],
		]);
		const c = fakeClient(objects);
		const aList = await snapshotList({ client: c, bucket: "b", prefix: "sites/abc/" });
		const bList = await snapshotList({ client: c, bucket: "b", prefix: "sites/def/" });
		expect(aList).toEqual([{ hash: "h1", current: true }]);
		expect(bList).toEqual([{ hash: "h2", current: true }]);
	});

	it("snapshotCurrent returns null when no current pointer", async () => {
		const result = await snapshotCurrent({
			client: fakeClient(new Map()),
			bucket: "b",
		});
		expect(result).toBeNull();
	});

	it("snapshotCat reads bytes by route key", async () => {
		const objects = new Map<string, { text: string; contentType?: string }>([
			["h1/index.html", { text: "<h1>home</h1>", contentType: "text/html;charset=utf-8" }],
		]);
		const result = await snapshotCat({
			client: fakeClient(objects),
			bucket: "b",
			snapshotHash: "h1",
			route: "/",
		});
		expect(new TextDecoder().decode(result.bytes)).toBe("<h1>home</h1>");
		expect(result.contentType).toBe("text/html;charset=utf-8");
	});

	it("snapshotCat throws structured error when entry missing", async () => {
		try {
			await snapshotCat({
				client: fakeClient(new Map()),
				bucket: "b",
				snapshotHash: "h1",
				route: "/about",
			});
			throw new Error("should have thrown");
		} catch (err) {
			expect(isAstroflareCliError(err)).toBe(true);
			if (isAstroflareCliError(err)) {
				expect(err.code).toBe(CLI_ERROR_CODES.R2_OBJECT_MISSING);
				expect(err.context.snapshotHash).toBe("h1");
			}
		}
	});
});
