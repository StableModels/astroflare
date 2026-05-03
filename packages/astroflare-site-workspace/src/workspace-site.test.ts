import { describe, expect, it } from "vitest";
import { type SqlBackend, type WorkspaceLike, WorkspaceSite } from "./workspace-site.js";

/**
 * Tiny in-memory `SqlBackend` mock that supports the subset of SQL
 * `WorkspaceSite` issues. Pattern-matches the literal queries — fine
 * for unit tests; not a sqlite implementation.
 */
function makeMockSql(): SqlBackend {
	const hashes = new Map<string, string>();
	let schemaInitialized = false;
	return {
		exec<T>(query: string, ...bindings: unknown[]): { toArray(): T[] } {
			const q = query.trim();
			if (q.startsWith("CREATE TABLE")) {
				schemaInitialized = true;
				return { toArray: () => [] };
			}
			if (!schemaInitialized) throw new Error("schema not initialized");
			if (q.startsWith("SELECT hash FROM aflare_hash WHERE path = ?")) {
				const path = bindings[0] as string;
				const hash = hashes.get(path);
				const rows = hash ? [{ hash }] : [];
				return { toArray: () => rows as T[] };
			}
			if (q.startsWith("INSERT OR REPLACE INTO aflare_hash")) {
				const [path, hash] = bindings as [string, string];
				hashes.set(path, hash);
				return { toArray: () => [] };
			}
			if (q.startsWith("DELETE FROM aflare_hash WHERE path = ?")) {
				const path = bindings[0] as string;
				hashes.delete(path);
				return { toArray: () => [] };
			}
			throw new Error(`unhandled query: ${q}`);
		},
	};
}

function makeMockWorkspace(): WorkspaceLike & {
	files: Map<string, Uint8Array>;
} {
	const files = new Map<string, Uint8Array>();
	return {
		files,
		async readFileBytes(path) {
			return files.get(path) ?? null;
		},
		async writeFileBytes(path, bytes) {
			const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBufferLike);
			files.set(path, new Uint8Array(u));
		},
		async deleteFile(path) {
			return files.delete(path);
		},
		async stat(path) {
			const f = files.get(path);
			return f ? { size: f.byteLength } : null;
		},
		async glob(pattern) {
			// Minimal: support `**/*.ext` and exact paths
			const out: { path: string }[] = [];
			for (const k of files.keys()) {
				if (pattern === "**" || k.includes(pattern.replace(/[*?]/g, ""))) {
					out.push({ path: k });
				}
			}
			return out;
		},
	};
}

describe("WorkspaceSite", () => {
	it("write computes hash and stat reads it back", async () => {
		const ws = makeMockWorkspace();
		const sql = makeMockSql();
		const site = new WorkspaceSite({ workspace: ws, sql });

		const bytes = new TextEncoder().encode("hello");
		const { hash, event } = await site.write("/foo.txt", bytes);

		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(event).toEqual({ kind: "write", path: "/foo.txt", hash });

		const stat = await site.statFile("/foo.txt");
		expect(stat).toEqual({ size: 5, hash });
	});

	it("readFile returns the bytes that were written", async () => {
		const ws = makeMockWorkspace();
		const sql = makeMockSql();
		const site = new WorkspaceSite({ workspace: ws, sql });
		const bytes = new TextEncoder().encode("astroflare");
		await site.write("/a.astro", bytes);
		const read = await site.readFile("/a.astro");
		expect(read).not.toBeNull();
		expect(new TextDecoder().decode(read as Uint8Array)).toBe("astroflare");
	});

	it("statFile returns null for missing files", async () => {
		const ws = makeMockWorkspace();
		const sql = makeMockSql();
		const site = new WorkspaceSite({ workspace: ws, sql });
		expect(await site.statFile("/missing")).toBeNull();
	});

	it("statFile back-fills hash for files written outside `write`", async () => {
		const ws = makeMockWorkspace();
		const sql = makeMockSql();
		// Write directly through the mock workspace (bypass WorkspaceSite.write).
		await ws.writeFileBytes("/external.txt", new TextEncoder().encode("ext"));
		const site = new WorkspaceSite({ workspace: ws, sql });
		const stat = await site.statFile("/external.txt");
		expect(stat).not.toBeNull();
		expect(stat?.hash).toMatch(/^[0-9a-f]{64}$/);
		// Subsequent stat hits the sidecar, returns the same hash.
		const stat2 = await site.statFile("/external.txt");
		expect(stat2?.hash).toBe(stat?.hash);
	});

	it("remove emits a delete event and clears the hash", async () => {
		const ws = makeMockWorkspace();
		const sql = makeMockSql();
		const site = new WorkspaceSite({ workspace: ws, sql });
		await site.write("/x.txt", new TextEncoder().encode("x"));
		const { existed, event } = await site.remove("/x.txt");
		expect(existed).toBe(true);
		expect(event).toEqual({ kind: "delete", path: "/x.txt" });
		expect(await site.statFile("/x.txt")).toBeNull();
	});

	it("glob yields workspace paths", async () => {
		const ws = makeMockWorkspace();
		const sql = makeMockSql();
		const site = new WorkspaceSite({ workspace: ws, sql });
		await site.write("/a.astro", new TextEncoder().encode("a"));
		await site.write("/b.astro", new TextEncoder().encode("b"));

		const paths: string[] = [];
		for await (const p of site.glob("**")) paths.push(p);
		expect(paths.sort()).toEqual(["/a.astro", "/b.astro"]);
	});
});
