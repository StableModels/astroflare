import { describe, expect, it } from "vitest";
import { createCoordinator } from "./coordinator.js";
import type { SqlBackend } from "./sql-cache.js";

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
});
