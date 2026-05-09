import { CompileError } from "@astroflare/compiler";
import type { HmrMessage } from "@astroflare/core";
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

	describe("verifyCompile pre-flight", () => {
		it("publishes HMR error with structured diagnostics on CompileError", async () => {
			const source = "---\nconst x: = 5;\n---\n<p>broken</p>\n";
			const compile = async (path: string) => {
				throw new CompileError({
					filename: path,
					source,
					diagnostics: [
						{
							message: "Unexpected token",
							start: { line: 2, column: 9, offset: 13 },
							end: { line: 2, column: 10, offset: 14 },
						},
					],
				});
			};
			const c = createCoordinator({ sql: makeMockSql(), compile });
			const seen: HmrMessage[] = [];
			c.subscribe("hmr", (m) => seen.push(m));

			await c.notifyChanged(
				{ kind: "write", path: "/src/pages/x.astro", hash: "h" },
				{ verifyCompile: true },
			);

			expect(seen).toHaveLength(1);
			const msg = seen[0];
			expect(msg?.type).toBe("error");
			if (msg?.type !== "error") throw new Error("expected error");
			expect(msg.error.message).toBe("Unexpected token");
			expect(msg.error.path).toBe("/src/pages/x.astro");
			expect(msg.error.line).toBe(2);
			expect(msg.error.column).toBe(9);
			expect(msg.error.diagnostics).toBeDefined();
			expect(msg.error.diagnostics?.[0]?.codeFrame?.text).toContain("const x: = 5;");
			expect(msg.error.codeFrame?.text).toContain("const x: = 5;");
			// Ring buffer captures the same event so operator tools can
			// inspect it without a live socket.
			const ring = c.recentHmrEvents();
			expect(ring).toHaveLength(1);
			expect(ring[0]?.message.type).toBe("error");
		});

		it("falls through to update on a clean compile", async () => {
			let invocations = 0;
			const compile = async () => {
				invocations++;
			};
			const c = createCoordinator({ sql: makeMockSql(), compile });
			const seen: HmrMessage[] = [];
			c.subscribe("hmr", (m) => seen.push(m));

			await c.notifyChanged(
				{ kind: "write", path: "/src/pages/x.astro", hash: "h" },
				{ verifyCompile: true },
			);
			expect(invocations).toBe(1);
			expect(seen[0]).toMatchObject({ type: "update", trigger: "/src/pages/x.astro" });
		});

		it("treats verifyCompile as a no-op without a compile hook", async () => {
			const c = createCoordinator({ sql: makeMockSql() });
			const seen: HmrMessage[] = [];
			c.subscribe("hmr", (m) => seen.push(m));

			await c.notifyChanged(
				{ kind: "write", path: "/src/pages/x.astro", hash: "h" },
				{ verifyCompile: true },
			);
			expect(seen[0]).toMatchObject({ type: "update", trigger: "/src/pages/x.astro" });
		});

		it("skips pre-flight for non-compilable paths even when requested", async () => {
			let invocations = 0;
			const compile = async () => {
				invocations++;
			};
			const c = createCoordinator({ sql: makeMockSql(), compile });
			const seen: HmrMessage[] = [];
			c.subscribe("hmr", (m) => seen.push(m));

			await c.notifyChanged(
				{ kind: "write", path: "/src/styles/site.css", hash: "h" },
				{ verifyCompile: true },
			);
			expect(invocations).toBe(0);
			expect(seen[0]).toMatchObject({ type: "update", trigger: "/src/styles/site.css" });
		});

		it("projects a non-CompileError throw as a bare-message HMR error", async () => {
			const compile = async () => {
				throw new Error("boom");
			};
			const c = createCoordinator({ sql: makeMockSql(), compile });
			const seen: HmrMessage[] = [];
			c.subscribe("hmr", (m) => seen.push(m));

			await c.notifyChanged(
				{ kind: "write", path: "/src/pages/x.astro", hash: "h" },
				{ verifyCompile: true },
			);
			const msg = seen[0];
			if (msg?.type !== "error") throw new Error("expected error");
			expect(msg.error.message).toBe("boom");
			expect(msg.error.path).toBe("/src/pages/x.astro");
			expect(msg.error.diagnostics).toBeUndefined();
		});

		it("still updates without verifyCompile even when the compile would fail", async () => {
			const compile = async () => {
				throw new Error("would fail");
			};
			const c = createCoordinator({ sql: makeMockSql(), compile });
			const seen: HmrMessage[] = [];
			c.subscribe("hmr", (m) => seen.push(m));

			// No verifyCompile flag — pre-flight is skipped, historical
			// behaviour preserved for embedders that haven't opted in.
			await c.notifyChanged({ kind: "write", path: "/src/pages/x.astro", hash: "h" });
			expect(seen[0]).toMatchObject({ type: "update", trigger: "/src/pages/x.astro" });
		});
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
