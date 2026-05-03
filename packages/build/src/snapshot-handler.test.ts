import type { SnapshotEntry, Snapshots } from "@astroflare/core";
import { describe, expect, it } from "vitest";
import { createSnapshotHandler } from "./snapshot-handler.js";

class MemorySnapshots implements Snapshots {
	#current: string | null = null;
	#entries = new Map<string, Map<string, SnapshotEntry>>();

	put(snapshotHash: string, entry: SnapshotEntry): void {
		let snap = this.#entries.get(snapshotHash);
		if (!snap) {
			snap = new Map();
			this.#entries.set(snapshotHash, snap);
		}
		const key = entry.route.replace(/^\/+/, "").replace(/\/+$/, "") || "/";
		snap.set(key, entry);
	}

	commit(snapshotHash: string): void {
		this.#current = snapshotHash;
	}

	async read(snapshotHash: string, route: string): Promise<SnapshotEntry | null> {
		const snap = this.#entries.get(snapshotHash);
		if (!snap) return null;
		const key = route.replace(/^\/+/, "").replace(/\/+$/, "") || "/";
		return snap.get(key) ?? null;
	}

	async current(): Promise<string | null> {
		return this.#current;
	}

	async list(): Promise<readonly string[]> {
		return Array.from(this.#entries.keys()).sort();
	}
}

function entry(route: string, html: string): SnapshotEntry {
	return {
		route,
		bytes: new TextEncoder().encode(html),
		contentType: "text/html;charset=utf-8",
		hash: `h-${route}`,
	};
}

describe("createSnapshotHandler", () => {
	it("returns 503 when no current deploy", async () => {
		const snapshots = new MemorySnapshots();
		const handler = createSnapshotHandler({ snapshots });
		const res = await handler.fetch(new Request("https://x/"));
		expect(res.status).toBe(503);
	});

	it("serves the root route from current snapshot", async () => {
		const snapshots = new MemorySnapshots();
		snapshots.put("h1", entry("/", "<h1>home</h1>"));
		snapshots.commit("h1");
		const handler = createSnapshotHandler({ snapshots });
		const res = await handler.fetch(new Request("https://x/"));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("<h1>home</h1>");
		expect(res.headers.get("content-type")).toBe("text/html;charset=utf-8");
		expect(res.headers.get("etag")).toBe('"h-/"');
	});

	it("serves nested routes via /<route>.html and /<route>/index.html candidates", async () => {
		const snapshots = new MemorySnapshots();
		snapshots.put("h1", entry("/about.html", "about-direct"));
		snapshots.put("h1", entry("/blog/post/index.html", "post-index"));
		snapshots.commit("h1");
		const handler = createSnapshotHandler({ snapshots });

		const res1 = await handler.fetch(new Request("https://x/about"));
		expect(res1.status).toBe(200);
		expect(await res1.text()).toBe("about-direct");

		const res2 = await handler.fetch(new Request("https://x/blog/post"));
		expect(res2.status).toBe(200);
		expect(await res2.text()).toBe("post-index");
	});

	it("returns 404 for unknown routes when there is a current deploy", async () => {
		const snapshots = new MemorySnapshots();
		snapshots.put("h1", entry("/", "home"));
		snapshots.commit("h1");
		const handler = createSnapshotHandler({ snapshots });
		const res = await handler.fetch(new Request("https://x/missing"));
		expect(res.status).toBe(404);
	});

	it("emits default cache-control: no-cache for HTML, max-age for everything else", async () => {
		const snapshots = new MemorySnapshots();
		snapshots.put("h1", entry("/", "<h1>x</h1>"));
		snapshots.put("h1", {
			route: "/style.css",
			bytes: new TextEncoder().encode("h1{}"),
			contentType: "text/css;charset=utf-8",
			hash: "h-style",
		});
		snapshots.commit("h1");
		const handler = createSnapshotHandler({ snapshots });

		const html = await handler.fetch(new Request("https://x/"));
		expect(html.headers.get("cache-control")).toContain("must-revalidate");

		const css = await handler.fetch(new Request("https://x/style.css"));
		expect(css.headers.get("cache-control")).toContain("max-age=3600");
	});

	it("custom cacheHeaders override default", async () => {
		const snapshots = new MemorySnapshots();
		snapshots.put("h1", entry("/", "<h1>x</h1>"));
		snapshots.commit("h1");
		const handler = createSnapshotHandler({
			snapshots,
			cacheHeaders: () => ({ "cache-control": "public, max-age=42" }),
		});
		const res = await handler.fetch(new Request("https://x/"));
		expect(res.headers.get("cache-control")).toBe("public, max-age=42");
	});
});
