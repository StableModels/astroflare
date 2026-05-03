/**
 * `CoordinatorDurableObject` tests under Miniflare's DO emulation.
 *
 * Exercise the persistent module graph directly via DO RPC, then via
 * the framework-facing `DurableObjectCoordinator` wrapper.
 */

import { env } from "cloudflare:test";
import { DurableObjectCoordinator } from "@astroflare/host-cloudflare";
import { afterEach, describe, expect, it } from "vitest";

let nextId = 0;
function uniqueDoId() {
	// Each test gets its own DO instance so state doesn't leak.
	const name = `test-${nextId++}-${Math.random().toString(36).slice(2)}`;
	return env.COORDINATOR_DO.idFromName(name);
}

const usedIds: DurableObjectId[] = [];

afterEach(async () => {
	// Best-effort cleanup. DOs can't be "deleted" but we can wipe their
	// graph state so subsequent tests start clean.
	for (const id of usedIds.splice(0)) {
		const stub = env.COORDINATOR_DO.get(id);
		const all = await stub.graphList();
		for (const node of all) {
			await stub.graphRemove(node.path);
		}
	}
});

describe("CoordinatorDurableObject: persistence", () => {
	it("persists a node across stub re-creation", async () => {
		const id = uniqueDoId();
		usedIds.push(id);

		// First stub: write.
		await env.COORDINATOR_DO.get(id).graphPut({
			path: "/src/pages/index.astro",
			hash: "abc123",
			imports: ["/src/components/Layout.astro"],
			importedBy: [],
		});

		// Fresh stub against the same id: read it back.
		const node = await env.COORDINATOR_DO.get(id).graphGet("/src/pages/index.astro");
		expect(node?.hash).toBe("abc123");
		expect(node?.imports).toEqual(["/src/components/Layout.astro"]);
	});

	it("returns null for a missing node", async () => {
		const id = uniqueDoId();
		usedIds.push(id);
		const node = await env.COORDINATOR_DO.get(id).graphGet("/nope.astro");
		expect(node).toBeNull();
	});
});

describe("CoordinatorDurableObject: reverse-edge bookkeeping", () => {
	it("populates importedBy on the import target when the importer is added", async () => {
		const id = uniqueDoId();
		usedIds.push(id);
		const stub = env.COORDINATOR_DO.get(id);

		await stub.graphPut({
			path: "/a.astro",
			hash: "h1",
			imports: ["/b.astro"],
			importedBy: [],
		});

		const b = await stub.graphGet("/b.astro");
		expect(b?.importedBy).toEqual(["/a.astro"]);
	});

	it("removes importedBy when the importer drops the import", async () => {
		const id = uniqueDoId();
		usedIds.push(id);
		const stub = env.COORDINATOR_DO.get(id);

		await stub.graphPut({
			path: "/a.astro",
			hash: "h1",
			imports: ["/b.astro"],
			importedBy: [],
		});
		await stub.graphPut({
			path: "/a.astro",
			hash: "h2",
			imports: [], // dropped /b.astro
			importedBy: [],
		});

		const b = await stub.graphGet("/b.astro");
		expect(b?.importedBy ?? []).toEqual([]);
	});

	it("graphRemove cleans up reverse edges on the target", async () => {
		const id = uniqueDoId();
		usedIds.push(id);
		const stub = env.COORDINATOR_DO.get(id);

		await stub.graphPut({
			path: "/a.astro",
			hash: "h1",
			imports: ["/b.astro"],
			importedBy: [],
		});
		await stub.graphRemove("/a.astro");

		const b = await stub.graphGet("/b.astro");
		expect(b?.importedBy ?? []).toEqual([]);
	});
});

describe("CoordinatorDurableObject: transitive walk", () => {
	it("walks the reverse closure", async () => {
		const id = uniqueDoId();
		usedIds.push(id);
		const stub = env.COORDINATOR_DO.get(id);

		// c → b → a (c imports b, b imports a)
		await stub.graphPut({ path: "/a.astro", hash: "ha", imports: [], importedBy: [] });
		await stub.graphPut({
			path: "/b.astro",
			hash: "hb",
			imports: ["/a.astro"],
			importedBy: [],
		});
		await stub.graphPut({
			path: "/c.astro",
			hash: "hc",
			imports: ["/b.astro"],
			importedBy: [],
		});

		const importers = await stub.transitiveImporters("/a.astro");
		expect(new Set(importers)).toEqual(new Set(["/b.astro", "/c.astro"]));
	});

	it("returns an empty list for a leaf with no importers", async () => {
		const id = uniqueDoId();
		usedIds.push(id);
		const stub = env.COORDINATOR_DO.get(id);
		await stub.graphPut({ path: "/a.astro", hash: "h", imports: [], importedBy: [] });
		const importers = await stub.transitiveImporters("/a.astro");
		expect(importers).toEqual([]);
	});
});

describe("DurableObjectCoordinator (framework-facing wrapper)", () => {
	it("routes graph ops through the DO and keeps pubsub local", async () => {
		const id = uniqueDoId();
		usedIds.push(id);
		const coord = new DurableObjectCoordinator(env.COORDINATOR_DO.get(id));

		const events: string[] = [];
		const sub = coord.subscribe("hmr", (msg) => {
			events.push(msg.type);
		});

		await coord.graphPut({
			path: "/a.astro",
			hash: "h",
			imports: [],
			importedBy: [],
		});

		await coord.onFileChanged("/a.astro", "h-new");
		expect(events).toEqual(["update"]);

		const node = await coord.graphGet("/a.astro");
		expect(node?.hash).toBe("h-new");

		sub.unsubscribe();

		// After unsubscribe, no more events are received.
		await coord.onFileChanged("/a.astro", "h-newer");
		expect(events).toEqual(["update"]);
	});

	it("publishes prune on file removal", async () => {
		const id = uniqueDoId();
		usedIds.push(id);
		const coord = new DurableObjectCoordinator(env.COORDINATOR_DO.get(id));

		await coord.graphPut({
			path: "/a.astro",
			hash: "h",
			imports: [],
			importedBy: [],
		});

		const messages: { type: string; paths?: string[] }[] = [];
		coord.subscribe("hmr", (msg) => {
			if (msg.type === "prune") messages.push({ type: msg.type, paths: msg.paths });
		});

		await coord.onFileRemoved("/a.astro");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.paths).toContain("/a.astro");
	});
});
