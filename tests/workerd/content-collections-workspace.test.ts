/**
 * Content collections + `WorkspaceSite` end-to-end inside workerd.
 *
 * Phase 26-style validation: the same content-collection flow that
 * `examples/minimal-blog/blog.test.ts` exercises against the in-memory
 * `MemorySite` works against `WorkspaceSite` — i.e. the file capability
 * a real Mode A host wires inside its `SiteDurableObject`.
 *
 * Coverage:
 *   - frontmatter parsing through `WorkspaceSite.readFile` → compiler
 *   - Zod schema validation (valid + deliberately-invalid entry → clear
 *     error response, not a crash)
 *   - schema default values apply (`tags: z.array(z.string()).default([])`)
 *   - glob discovery returns exactly the seeded entries
 *   - HMR mutation: write a new entry via `WorkspaceSite.write`, fire
 *     `coordinator.notifyChanged`, subsequent `getCollection` includes it
 *
 * Uses a mock Workspace + mock SQL backend so the test stays focused on
 * the WorkspaceSite ↔ content-collection contract; the
 * `WorkspaceSite` test in `packages/site-workspace/` already
 * covers the SQL-backed sidecar against the same mock shape, and the
 * Workspace adapter itself is exercised in the `@cloudflare/shell`
 * package's own tests.
 */

import { createContentReader, defineCollection, z } from "@astroflare/content";
import {
	type SqlBackend,
	type WorkspaceLike,
	WorkspaceSite,
	createCoordinator,
} from "@astroflare/host-cloudflare";
import { describe, expect, it } from "vitest";

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * In-memory SQL backend supporting the literal queries `WorkspaceSite`
 * and `createCoordinator` issue. Same pattern the package-level tests
 * use — sufficient for the read/write/HMR flows we're exercising here.
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
			if (!initialized) throw new Error("schema not initialized");

			// aflare_hash table (WorkspaceSite)
			if (q.startsWith("SELECT hash FROM aflare_hash WHERE path = ?")) {
				const path = bindings[0] as string;
				const row = ensure("aflare_hash").get(path);
				return { toArray: () => (row ? [row] : []) } as { toArray(): T[] };
			}
			if (q.startsWith("INSERT OR REPLACE INTO aflare_hash")) {
				const [path, hash] = bindings as [string, string];
				ensure("aflare_hash").set(path, { hash });
				return { toArray: () => [] };
			}
			if (q.startsWith("DELETE FROM aflare_hash WHERE path = ?")) {
				ensure("aflare_hash").delete(bindings[0] as string);
				return { toArray: () => [] };
			}

			// aflare_module_graph (createCoordinator)
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

/**
 * Mock `Workspace`-shape — minimum surface `WorkspaceSite` consumes.
 * Reuses the pattern from `workspace-site.test.ts`. `glob()` matches
 * the shape `getCollection` issues: `/src/content/<name>/**\/*.md`.
 */
function makeMockWorkspace(): WorkspaceLike & { files: Map<string, Uint8Array> } {
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
			// Support the patterns content collections use:
			// `/src/content/<name>/**/*.md` and `/src/content/<name>/**/*.mdx`.
			const ext = pattern.match(/\.([a-z0-9]+)$/i)?.[0] ?? "";
			const prefix = pattern.replace(/\*+\/.*$/, "").replace(/\*+$/, "");
			const out: { path: string }[] = [];
			for (const k of files.keys()) {
				if (prefix && !k.startsWith(prefix)) continue;
				if (ext && !k.endsWith(ext)) continue;
				out.push({ path: k });
			}
			return out;
		},
	};
}

const blogSchema = z.object({
	title: z.string(),
	pubDate: z.string().or(z.date()),
	tags: z.array(z.string()).default([]),
});

interface BlogData {
	title: string;
	pubDate: string | Date;
	tags: string[];
}

function bootSiteWithEntries(extras: Record<string, string> = {}): {
	site: WorkspaceSite;
	files: Map<string, Uint8Array>;
} {
	const ws = makeMockWorkspace();
	const sql = makeMockSql();
	const site = new WorkspaceSite({ workspace: ws, sql });

	const seedEntries = {
		"/src/content/blog/hello-world.md":
			"---\ntitle: Hello, World\npubDate: 2026-05-02\ntags: [intro, hello]\n---\n# Hello!\n",
		"/src/content/blog/second-post.md":
			"---\ntitle: A Second Post\npubDate: 2026-05-09\ntags: [updates]\n---\n# Second\n",
		"/src/content/blog/third-post.md":
			"---\ntitle: Third\npubDate: 2026-05-16\n---\n# Third (no tags)\n",
		...extras,
	};
	for (const [path, body] of Object.entries(seedEntries)) {
		// Workspace files start with `/`; WorkspaceSite preserves that.
		ws.files.set(path, enc(body));
	}
	return { site, files: ws.files };
}

describe("content collections against WorkspaceSite", () => {
	it("getCollection returns schema-validated entries discovered via glob", async () => {
		const { site } = bootSiteWithEntries();
		const reader = createContentReader(site, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});

		const all = await reader.getCollection<BlogData>("blog");
		expect(all).toHaveLength(3);
		// Sorted by slug.
		expect(all.map((e) => e.slug)).toEqual(["hello-world", "second-post", "third-post"]);
		expect(all[0]?.data.title).toBe("Hello, World");
		expect(all[0]?.data.tags).toEqual(["intro", "hello"]);
		expect(all[1]?.data.title).toBe("A Second Post");
	});

	it("schema default values apply when frontmatter omits them", async () => {
		const { site } = bootSiteWithEntries();
		const reader = createContentReader(site, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});

		const third = (await reader.getCollection<BlogData>("blog")).find(
			(e) => e.slug === "third-post",
		);
		expect(third).toBeDefined();
		// `tags` was missing from the third post's frontmatter; the
		// schema's `.default([])` should kick in.
		expect(third?.data.tags).toEqual([]);
	});

	it("getEntry returns frontmatter + body for a single slug", async () => {
		const { site } = bootSiteWithEntries();
		const reader = createContentReader(site, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});

		const hello = await reader.getEntry<BlogData>("blog", "hello-world");
		expect(hello).not.toBeNull();
		expect(hello?.data.title).toBe("Hello, World");
		expect(hello?.body.trim()).toBe("# Hello!");
	});

	it("getEntry returns null for an unknown slug", async () => {
		const { site } = bootSiteWithEntries();
		const reader = createContentReader(site, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});

		const ghost = await reader.getEntry<BlogData>("blog", "does-not-exist");
		expect(ghost).toBeNull();
	});

	it("schema-invalid entries raise a clear error, not a crash", async () => {
		const { site } = bootSiteWithEntries({
			"/src/content/blog/broken.md":
				"---\n# missing required `title`\npubDate: 2026-05-25\n---\nbody\n",
		});
		const reader = createContentReader(site, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});

		await expect(reader.getCollection<BlogData>("blog")).rejects.toThrow(
			/broken\.md failed schema/i,
		);
	});

	it("glob discovery returns exactly the seeded entries (nothing extra)", async () => {
		const { site, files } = bootSiteWithEntries();
		// Add some non-collection files that should NOT appear.
		files.set("/src/content/blog/not-markdown.txt", enc("noise"));
		files.set("/src/pages/index.astro", enc("---\n---\n<h1>noise</h1>"));

		const reader = createContentReader(site, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});
		const slugs = (await reader.getCollection<BlogData>("blog")).map((e) => e.slug);
		expect(slugs.sort()).toEqual(["hello-world", "second-post", "third-post"]);
	});

	it("HMR-style mutation: writing a new entry surfaces in subsequent getCollection", async () => {
		const { site } = bootSiteWithEntries();
		const sql = makeMockSql();
		const coordinator = createCoordinator({ sql, site });
		const reader = createContentReader(site, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});

		const before = await reader.getCollection<BlogData>("blog");
		expect(before.map((e) => e.slug)).toEqual(["hello-world", "second-post", "third-post"]);

		// Drive the mutation through the same path a host's
		// /_aflare/site/file POST endpoint uses: WorkspaceSite.write,
		// then coordinator.notifyChanged. This is the contract the
		// reference preview host's SiteDurableObject implements.
		const newBody = "---\ntitle: Fourth post\npubDate: 2026-05-23\ntags: [fresh]\n---\n# Fourth!\n";
		const { event } = await site.write("/src/content/blog/fourth-post.md", enc(newBody));
		await coordinator.notifyChanged(event);

		const after = await reader.getCollection<BlogData>("blog");
		expect(after.map((e) => e.slug).sort()).toEqual([
			"fourth-post",
			"hello-world",
			"second-post",
			"third-post",
		]);
		const fourth = after.find((e) => e.slug === "fourth-post");
		expect(fourth?.data.title).toBe("Fourth post");
		expect(fourth?.data.tags).toEqual(["fresh"]);
	});

	it("HMR-style deletion: removing an entry drops it from the next read", async () => {
		const { site } = bootSiteWithEntries();
		const sql = makeMockSql();
		const coordinator = createCoordinator({ sql, site });
		const reader = createContentReader(site, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});

		const { event } = await site.remove("/src/content/blog/second-post.md");
		await coordinator.notifyChanged(event);

		const after = await reader.getCollection<BlogData>("blog");
		expect(after.map((e) => e.slug).sort()).toEqual(["hello-world", "third-post"]);
	});
});
