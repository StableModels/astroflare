import type { HmrMessage } from "@astroflare/core";
import { MemoryCache, MemorySite } from "@astroflare/test-utils/in-memory";
import { describe, expect, it } from "vitest";
import { createCoordinator } from "./coordinator.js";
import type { SqlBackend } from "./sql-cache.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * In-memory `SqlBackend` mock that handles the exact queries
 * `createCoordinator` and `SqlCache` issue. Smaller than spinning up
 * better-sqlite3, sufficient for verifying the change-pipeline +
 * graph logic in isolation from workerd.
 */
function makeMockSql(): SqlBackend {
	const tables = new Map<string, Map<string, Record<string, unknown>>>();
	const ensure = (name: string) => {
		if (!tables.has(name)) tables.set(name, new Map());
		return tables.get(name) as Map<string, Record<string, unknown>>;
	};
	let initialized = false;
	return {
		exec<T>(query: string, ...bindings: unknown[]): { toArray(): T[] } {
			const q = query.trim();
			if (q.startsWith("CREATE TABLE") || q.startsWith("CREATE INDEX")) {
				initialized = true;
				return { toArray: () => [] };
			}
			if (!initialized) throw new Error(`schema not initialized: ${q.slice(0, 60)}`);

			// aflare_module_graph SELECT by path
			if (q.startsWith("SELECT path, hash, imports_json FROM aflare_module_graph WHERE path = ?")) {
				const path = bindings[0] as string;
				const row = ensure("aflare_module_graph").get(path);
				return { toArray: () => (row ? [row] : []) } as { toArray(): T[] };
			}
			if (q.startsWith("SELECT path, hash, imports_json FROM aflare_module_graph ORDER BY path")) {
				const rows = Array.from(ensure("aflare_module_graph").values()).sort((a, b) =>
					(a.path as string).localeCompare(b.path as string),
				);
				return { toArray: () => rows } as { toArray(): T[] };
			}
			if (q.startsWith("INSERT OR REPLACE INTO aflare_module_graph")) {
				const [path, hash, imports_json] = bindings as [string, string, string];
				ensure("aflare_module_graph").set(path, { path, hash, imports_json });
				return { toArray: () => [] };
			}
			if (q.startsWith("UPDATE aflare_module_graph SET imports_json = ? WHERE path = ?")) {
				const [imports_json, path] = bindings as [string, string];
				const existing = ensure("aflare_module_graph").get(path);
				if (existing) ensure("aflare_module_graph").set(path, { ...existing, imports_json });
				return { toArray: () => [] };
			}
			if (q.startsWith("DELETE FROM aflare_module_graph WHERE path = ?")) {
				ensure("aflare_module_graph").delete(bindings[0] as string);
				return { toArray: () => [] };
			}

			// aflare_module_imported_by SELECT/INSERT/DELETE
			if (q.startsWith("SELECT importer FROM aflare_module_imported_by WHERE path = ?")) {
				const path = bindings[0] as string;
				const ib = ensure("aflare_module_imported_by");
				const out: { importer: string }[] = [];
				for (const k of ib.keys()) {
					if (k.startsWith(`${path}|`)) {
						out.push({ importer: k.slice(path.length + 1) });
					}
				}
				return { toArray: () => out } as { toArray(): T[] };
			}
			if (q.startsWith("INSERT OR IGNORE INTO aflare_module_imported_by")) {
				const [path, importer] = bindings as [string, string];
				ensure("aflare_module_imported_by").set(`${path}|${importer}`, { path, importer });
				return { toArray: () => [] };
			}
			if (q.startsWith("DELETE FROM aflare_module_imported_by WHERE path = ? AND importer = ?")) {
				const [path, importer] = bindings as [string, string];
				ensure("aflare_module_imported_by").delete(`${path}|${importer}`);
				return { toArray: () => [] };
			}
			if (q.startsWith("DELETE FROM aflare_module_imported_by WHERE path = ?")) {
				const [path] = bindings as [string];
				const ib = ensure("aflare_module_imported_by");
				for (const k of Array.from(ib.keys())) {
					if (k.startsWith(`${path}|`)) ib.delete(k);
				}
				return { toArray: () => [] };
			}

			throw new Error(`unhandled query: ${q.slice(0, 80)}`);
		},
	};
}

describe("createCoordinator", () => {
	it("graphPut + graphGet round-trip through sqlite", async () => {
		const c = createCoordinator({ sql: makeMockSql() });
		await c.graphPut({
			path: "/a.astro",
			hash: "h1",
			imports: ["/b.astro"],
			importedBy: [],
		});
		const node = await c.graphGet("/a.astro");
		expect(node).toEqual({
			path: "/a.astro",
			hash: "h1",
			imports: ["/b.astro"],
			importedBy: [],
		});
	});

	it("reverse edges populate via graphPut", async () => {
		const c = createCoordinator({ sql: makeMockSql() });
		await c.graphPut({ path: "/a.astro", hash: "h1", imports: ["/b.astro"], importedBy: [] });
		await c.graphPut({ path: "/b.astro", hash: "h2", imports: [], importedBy: [] });
		const b = await c.graphGet("/b.astro");
		expect(b?.importedBy).toEqual(["/a.astro"]);
	});

	it("transitiveImporters walks reverse edges", async () => {
		const c = createCoordinator({ sql: makeMockSql() });
		await c.graphPut({ path: "/c.astro", hash: "h3", imports: [], importedBy: [] });
		await c.graphPut({ path: "/b.astro", hash: "h2", imports: ["/c.astro"], importedBy: [] });
		await c.graphPut({ path: "/a.astro", hash: "h1", imports: ["/b.astro"], importedBy: [] });
		const importers = await c.transitiveImporters("/c.astro");
		expect([...importers].sort()).toEqual(["/a.astro", "/b.astro"]);
	});

	it("notifyChanged publishes hmr update with transitive importers", async () => {
		const c = createCoordinator({ sql: makeMockSql() });
		await c.graphPut({ path: "/b.astro", hash: "old", imports: [], importedBy: [] });
		await c.graphPut({ path: "/a.astro", hash: "h1", imports: ["/b.astro"], importedBy: [] });

		const messages: unknown[] = [];
		c.subscribe("hmr", (m) => messages.push(m));

		await c.notifyChanged({ kind: "write", path: "/b.astro", hash: "new" });

		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			type: "update",
			trigger: "/b.astro",
			updates: expect.arrayContaining([
				expect.objectContaining({ path: "/b.astro", hash: "new" }),
				expect.objectContaining({ path: "/a.astro" }),
			]),
		});

		// Node updated to new hash.
		const b = await c.graphGet("/b.astro");
		expect(b?.hash).toBe("new");
	});

	it("recentHmrEvents records published events oldest → newest", async () => {
		const c = createCoordinator({ sql: makeMockSql() });
		expect(c.recentHmrEvents()).toEqual([]);

		await c.graphPut({ path: "/a.astro", hash: "h1", imports: [], importedBy: [] });
		await c.graphPut({ path: "/b.astro", hash: "h2", imports: [], importedBy: [] });

		const t0 = Date.now();
		await c.notifyChanged({ kind: "write", path: "/a.astro", hash: "h1b" });
		await c.notifyChanged({ kind: "write", path: "/b.astro", hash: "h2b" });

		const events = c.recentHmrEvents();
		expect(events).toHaveLength(2);
		expect(events[0]?.message).toMatchObject({ type: "update", trigger: "/a.astro" });
		expect(events[1]?.message).toMatchObject({ type: "update", trigger: "/b.astro" });
		// Timestamps are non-decreasing and within reach of `now`.
		expect(events[0]?.at).toBeGreaterThanOrEqual(t0);
		expect(events[1]?.at).toBeGreaterThanOrEqual(events[0]?.at ?? 0);

		// `limit` returns the most recent N entries.
		expect(c.recentHmrEvents(1)).toHaveLength(1);
		expect(c.recentHmrEvents(1)[0]?.message).toMatchObject({ trigger: "/b.astro" });
		expect(c.recentHmrEvents(0)).toEqual([]);
	});

	it("recentHmrEvents caps at the ring size and drops oldest entries", async () => {
		const c = createCoordinator({ sql: makeMockSql() });
		// Ring cap is 32; push 40 events and assert we keep the
		// most-recent 32 in oldest → newest order.
		for (let i = 0; i < 40; i++) {
			await c.graphPut({ path: `/m${i}.astro`, hash: `h${i}`, imports: [], importedBy: [] });
			await c.notifyChanged({ kind: "write", path: `/m${i}.astro`, hash: `h${i}n` });
		}
		const events = c.recentHmrEvents();
		expect(events).toHaveLength(32);
		// The first kept event was `m8` (40 - 32); last is `m39`.
		expect(events[0]?.message).toMatchObject({ trigger: "/m8.astro" });
		expect(events.at(-1)?.message).toMatchObject({ trigger: "/m39.astro" });
	});

	it("simulateChange drives the same pipeline as notifyChanged", async () => {
		const c = createCoordinator({ sql: makeMockSql() });
		await c.graphPut({ path: "/b.astro", hash: "old", imports: [], importedBy: [] });
		await c.graphPut({ path: "/a.astro", hash: "h1", imports: ["/b.astro"], importedBy: [] });

		const seen: unknown[] = [];
		c.subscribe("hmr", (m) => seen.push(m));

		await c.simulateChange({ kind: "write", path: "/b.astro", hash: "new" });

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			type: "update",
			trigger: "/b.astro",
			updates: expect.arrayContaining([
				expect.objectContaining({ path: "/b.astro", hash: "new" }),
				expect.objectContaining({ path: "/a.astro" }),
			]),
		});
		// And the ring buffer recorded the same event.
		expect(c.recentHmrEvents()).toHaveLength(1);
	});

	it("notifyRemoved publishes hmr prune and removes the node", async () => {
		const c = createCoordinator({ sql: makeMockSql() });
		await c.graphPut({ path: "/b.astro", hash: "h2", imports: [], importedBy: [] });
		await c.graphPut({ path: "/a.astro", hash: "h1", imports: ["/b.astro"], importedBy: [] });

		const messages: unknown[] = [];
		c.subscribe("hmr", (m) => messages.push(m));

		await c.notifyRemoved("/b.astro");

		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			type: "prune",
			paths: expect.arrayContaining(["/b.astro", "/a.astro"]),
		});
		expect(await c.graphGet("/b.astro")).toBeNull();
	});

	// Without `site` + `cache` the coordinator can't compile, so it
	// degrades to the plain reverse-edge walk: write → unconditional
	// `update`, delete → unconditional `prune`. (Pure-graph unit tests
	// and the preview-handler suite rely on this — they wire the cache
	// into `createPreviewHandler`, not the coordinator.)
	it("no site/cache → plain update/prune (no pre-flight)", async () => {
		const c = createCoordinator({ sql: makeMockSql() });
		await c.graphPut({ path: "/b.astro", hash: "h2", imports: [], importedBy: [] });
		await c.graphPut({ path: "/a.astro", hash: "h1", imports: ["/b.astro"], importedBy: [] });
		const seen: HmrMessage[] = [];
		c.subscribe("hmr", (m) => seen.push(m));

		await c.notifyChanged({ kind: "write", path: "/b.astro", hash: "h2b" });
		await c.notifyChanged({ kind: "delete", path: "/b.astro" });

		expect(seen[0]).toMatchObject({ type: "update", trigger: "/b.astro" });
		expect(seen[1]?.type).toBe("prune");
	});

	// The closure/route-aware compile pre-flight is **on by default**
	// whenever the coordinator has `site` + `cache` — no opt-in flag, no
	// host-side substitute. These exercise the contract end to end
	// against a real `MemorySite` + `MemoryCache` + the framework's own
	// `ModuleGraph`/`Router`.
	describe("closure/route-aware pre-flight (default-on with site + cache)", () => {
		function boot() {
			const site = new MemorySite();
			const cache = new MemoryCache();
			const c = createCoordinator({ sql: makeMockSql(), site, cache });
			const seen: HmrMessage[] = [];
			c.subscribe("hmr", (m) => seen.push(m));
			return { site, cache, c, seen };
		}

		it("clean write → update", async () => {
			const { site, c, seen } = boot();
			site.write("/src/pages/index.astro", enc("<p>hello</p>"));
			await c.notifyChanged({ kind: "write", path: "/src/pages/index.astro", hash: "h1" });
			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({ type: "update", trigger: "/src/pages/index.astro" });
		});

		it("page importing a missing component → error (not update)", async () => {
			const { site, c, seen } = boot();
			site.write(
				"/src/pages/index.astro",
				enc('---\nimport SiteHeader from "../components/SiteHeader.astro";\n---\n<SiteHeader />'),
			);
			await c.notifyChanged({ kind: "write", path: "/src/pages/index.astro", hash: "h1" });
			expect(seen).toHaveLength(1);
			const msg = seen[0];
			if (msg?.type !== "error") throw new Error("expected error");
			expect(msg.error.path).toBe("/src/pages/index.astro");
			expect(msg.error.message).toContain("source not found");
			expect(msg.error.message).toContain("SiteHeader.astro");
		});

		it("broken syntax → error with structured diagnostics", async () => {
			const { site, c, seen } = boot();
			site.write("/src/pages/index.astro", enc("---\nconst x: = 5;\n---\n<p>broken</p>"));
			await c.notifyChanged({ kind: "write", path: "/src/pages/index.astro", hash: "h1" });
			const msg = seen[0];
			if (msg?.type !== "error") throw new Error("expected error");
			expect(msg.error.path).toBe("/src/pages/index.astro");
			expect(msg.error.diagnostics).toBeDefined();
			expect(msg.error.diagnostics?.length ?? 0).toBeGreaterThan(0);
			expect(msg.error.codeFrame?.text).toContain("const x: = 5;");
		});

		it("recovers on a follow-up clean edit (missing component is created)", async () => {
			const { site, c, seen } = boot();
			site.write(
				"/src/pages/index.astro",
				enc('---\nimport SiteHeader from "../components/SiteHeader.astro";\n---\n<SiteHeader />'),
			);
			await c.notifyChanged({ kind: "write", path: "/src/pages/index.astro", hash: "h1" });
			expect(seen[0]?.type).toBe("error");

			// The component lands — pre-flight follows the reverse edge
			// (SiteHeader → index, recorded during the failed closure walk)
			// back to the page, re-walks its closure clean, and updates.
			site.write("/src/components/SiteHeader.astro", enc("<header>site</header>"));
			await c.notifyChanged({
				kind: "write",
				path: "/src/components/SiteHeader.astro",
				hash: "h2",
			});
			expect(seen).toHaveLength(2);
			expect(seen[1]).toMatchObject({
				type: "update",
				trigger: "/src/components/SiteHeader.astro",
			});
		});

		it("non-compilable path skips the check → update", async () => {
			const { c, seen } = boot();
			await c.notifyChanged({ kind: "write", path: "/src/styles/site.css", hash: "h1" });
			expect(seen[0]).toMatchObject({ type: "update", trigger: "/src/styles/site.css" });
		});

		it("orphan module (no reachable route) falls back to single-file compile", async () => {
			const { site, c, seen } = boot();
			// A component nobody imports yet, with a syntax error. No
			// reachable route → single-file compile still catches it.
			site.write("/src/components/Orphan.astro", enc("---\nconst y: = 1;\n---\n<p>o</p>"));
			await c.notifyChanged({ kind: "write", path: "/src/components/Orphan.astro", hash: "h1" });
			const msg = seen[0];
			if (msg?.type !== "error") throw new Error("expected error");
			expect(msg.error.path).toBe("/src/components/Orphan.astro");
			expect(msg.error.diagnostics).toBeDefined();
		});

		it("orphan module that compiles clean → update", async () => {
			const { site, c, seen } = boot();
			site.write("/src/components/Lonely.astro", enc("<aside>ok</aside>"));
			await c.notifyChanged({ kind: "write", path: "/src/components/Lonely.astro", hash: "h1" });
			expect(seen[0]).toMatchObject({ type: "update", trigger: "/src/components/Lonely.astro" });
		});

		it("delete of a file nothing imports → prune", async () => {
			const { site, c, seen } = boot();
			site.write("/src/pages/old.astro", enc("<p>old</p>"));
			await c.notifyChanged({ kind: "write", path: "/src/pages/old.astro", hash: "h1" });
			expect(seen[0]?.type).toBe("update");

			site.remove("/src/pages/old.astro");
			await c.notifyChanged({ kind: "delete", path: "/src/pages/old.astro" });
			expect(seen).toHaveLength(2);
			expect(seen[1]).toMatchObject({
				type: "prune",
				paths: expect.arrayContaining(["/src/pages/old.astro"]),
			});
			expect(await c.graphGet("/src/pages/old.astro")).toBeNull();
		});

		it("delete of a file a reachable route still imports → error, no prune", async () => {
			const { site, c, seen } = boot();
			site.write("/src/components/SiteHeader.astro", enc("<header>site</header>"));
			site.write(
				"/src/pages/index.astro",
				enc('---\nimport SiteHeader from "../components/SiteHeader.astro";\n---\n<SiteHeader />'),
			);
			await c.notifyChanged({ kind: "write", path: "/src/pages/index.astro", hash: "h1" });
			expect(seen[0]?.type).toBe("update");

			// Reference-host flow: remove the bytes, then notify. The guard
			// reads reverse edges before the prune mutates them, re-walks
			// `index`'s closure, hits the missing import, publishes `error`,
			// and skips the prune.
			site.remove("/src/components/SiteHeader.astro");
			await c.notifyChanged({ kind: "delete", path: "/src/components/SiteHeader.astro" });
			expect(seen).toHaveLength(2);
			const msg = seen[1];
			if (msg?.type !== "error") throw new Error(`expected error, got ${msg?.type}`);
			expect(msg.error.path).toBe("/src/components/SiteHeader.astro");
			expect(msg.error.message).toContain("source not found");
			// Prune was skipped → graph still holds the (now-stranded) edge,
			// so a later re-create can recover via the same reverse edge.
			expect(seen.some((m) => m.type === "prune")).toBe(false);
		});
	});
});
