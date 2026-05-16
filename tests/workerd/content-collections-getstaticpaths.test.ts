/**
 * Host-driven content collections, end-to-end inside workerd.
 *
 * Validates the feature's core promise: `import { getCollection } from
 * "astro:content"` resolves in `.astro` frontmatter *and* in a dynamic
 * route's `getStaticPaths()`, in **both** the Mode A preview path
 * (`createPreviewHandler`) and the Mode B workers build path
 * (`buildSite`), with matching route sets — preview ↔ publish
 * lock-step.
 *
 * Coverage:
 *   - dynamic `/blog/[slug]` whose `getStaticPaths()` calls
 *     `getCollection('blog')` enumerates one page per
 *     `/src/content/blog/*.md` in buildSite and createPreviewHandler
 *   - a static list page using `getCollection` in frontmatter renders
 *     every entry
 *   - the produced route sets match (the lock-step invariant)
 *   - adding a `/src/content/**` file busts the cache and the new slug
 *     renders on the next preview request with no source edit to the
 *     route (HMR re-bake via the content-digest cache key)
 *
 * Mirrors `content-collections-workspace.test.ts` (the reader-level
 * WorkspaceSite coverage) one layer up — at the isolate boundary.
 */

import { env } from "cloudflare:test";
import { buildSite } from "@astroflare/build";
import type { SnapshotEntry } from "@astroflare/core";
import {
	type SqlBackend,
	createCoordinator,
	createPreviewHandler,
	createWorkerdExecutor,
} from "@astroflare/host-cloudflare";
import { runtimeModules } from "@astroflare/host-cloudflare/runtime-modules";
import { MemoryCache, MemorySite } from "@astroflare/test-utils/in-memory";
import { describe, expect, it } from "vitest";

const enc = (s: string) => new TextEncoder().encode(s);

/** Minimal `SqlBackend` for `createCoordinator` (module-graph + hash). */
function makeMockSql(): SqlBackend {
	const tables = new Map<string, Map<string, Record<string, unknown>>>();
	const ensure = (n: string) => {
		if (!tables.has(n)) tables.set(n, new Map());
		return tables.get(n) as Map<string, Record<string, unknown>>;
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
			if (q.startsWith("SELECT path, hash, imports_json FROM aflare_module_graph WHERE path = ?")) {
				const row = ensure("aflare_module_graph").get(bindings[0] as string);
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
				const e = ensure("aflare_module_graph").get(path);
				if (e) ensure("aflare_module_graph").set(path, { ...e, imports_json });
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
					if (k.startsWith(`${path}|`)) out.push({ importer: k.slice(path.length + 1) });
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
				const ib = ensure("aflare_module_imported_by");
				const path = bindings[0] as string;
				for (const k of Array.from(ib.keys())) if (k.startsWith(`${path}|`)) ib.delete(k);
				return { toArray: () => [] };
			}
			throw new Error(`unhandled query: ${q.slice(0, 80)}`);
		},
	};
}

const SLUG_ROUTE = `---
import { getCollection } from 'astro:content';
export async function getStaticPaths() {
	const posts = await getCollection('blog');
	return posts.map((p) => ({ params: { slug: p.slug }, props: { post: p } }));
}
const { post } = Astro.props;
---
<h1>{post.data.title}</h1>
<article>{post.body}</article>`;

const LIST_PAGE = `---
import { getCollection } from 'astro:content';
const posts = await getCollection('blog');
---
<ul>{posts.map((p) => (<li>{p.data.title}</li>))}</ul>`;

function seedSite(): MemorySite {
	const site = new MemorySite();
	site.write("/src/pages/blog/[slug].astro", enc(SLUG_ROUTE));
	site.write("/src/pages/blog/index.astro", enc(LIST_PAGE));
	site.write(
		"/src/content/blog/hello-world.md",
		enc("---\ntitle: Hello, World\n---\nthe hello body\n"),
	);
	site.write(
		"/src/content/blog/second-post.md",
		enc("---\ntitle: A Second Post\n---\nthe second body\n"),
	);
	return site;
}

function makeExecutor() {
	return createWorkerdExecutor({
		loader: env.LOADER,
		compatibilityDate: "2025-09-01",
		compatibilityFlags: ["nodejs_compat"],
		runtime: runtimeModules,
	});
}

describe("host-driven content collections — getStaticPaths + frontmatter, lock-step", () => {
	it("Mode B buildSite enumerates one page per /src/content/blog/*.md", async () => {
		const site = seedSite();
		const executor = makeExecutor();

		const produced: SnapshotEntry[] = [];
		for await (const entry of buildSite({ site, executor })) produced.push(entry);

		const byRoute = new Map(produced.map((e) => [e.route, new TextDecoder().decode(e.bytes)]));
		expect([...byRoute.keys()].sort()).toEqual(["/blog", "/blog/hello-world", "/blog/second-post"]);
		expect(byRoute.get("/blog/hello-world")).toContain("Hello, World");
		expect(byRoute.get("/blog/hello-world")).toContain("the hello body");
		expect(byRoute.get("/blog/second-post")).toContain("A Second Post");
		// The list page used getCollection in frontmatter.
		expect(byRoute.get("/blog")).toContain("Hello, World");
		expect(byRoute.get("/blog")).toContain("A Second Post");
	});

	it("Mode A createPreviewHandler resolves the same routes from the same collection", async () => {
		const site = seedSite();
		const coordinator = createCoordinator({ sql: makeMockSql() });
		const handler = createPreviewHandler({
			site,
			coordinator,
			executor: makeExecutor(),
			cache: new MemoryCache(),
		});

		const hello = await handler.fetch(new Request("https://app/blog/hello-world"));
		expect(hello.status, await hello.clone().text()).toBe(200);
		const helloHtml = await hello.text();
		expect(helloHtml).toContain("Hello, World");
		expect(helloHtml).toContain("the hello body");

		const second = await handler.fetch(new Request("https://app/blog/second-post"));
		expect(second.status).toBe(200);
		expect(await second.text()).toContain("A Second Post");

		const list = await handler.fetch(new Request("https://app/blog"));
		expect(list.status).toBe(200);
		const listHtml = await list.text();
		expect(listHtml).toContain("Hello, World");
		expect(listHtml).toContain("A Second Post");

		// A slug with no backing entry 404s (getStaticPaths filter).
		const ghost = await handler.fetch(new Request("https://app/blog/not-a-post"));
		expect(ghost.status).toBe(404);
	});

	it("preview ↔ publish lock-step: identical route sets", async () => {
		const buildSiteRoutes: string[] = [];
		for await (const entry of buildSite({ site: seedSite(), executor: makeExecutor() })) {
			buildSiteRoutes.push(entry.route);
		}

		const site = seedSite();
		const handler = createPreviewHandler({
			site,
			coordinator: createCoordinator({ sql: makeMockSql() }),
			executor: makeExecutor(),
			cache: new MemoryCache(),
		});
		for (const route of buildSiteRoutes) {
			const res = await handler.fetch(new Request(`https://app${route}`));
			expect(res.status, `preview must serve ${route}`).toBe(200);
		}
		expect(buildSiteRoutes.sort()).toEqual(["/blog", "/blog/hello-world", "/blog/second-post"]);
	});

	it("adding a /src/content/**.md busts the cache and renders the new slug (HMR)", async () => {
		const site = seedSite();
		const coordinator = createCoordinator({ sql: makeMockSql() });
		const handler = createPreviewHandler({
			site,
			coordinator,
			executor: makeExecutor(),
			cache: new MemoryCache(),
		});

		// Warm the cache: third post isn't declared yet.
		expect((await handler.fetch(new Request("https://app/blog/third-post"))).status).toBe(404);

		// Add a new entry the way a host's file endpoint would, then
		// drive the change pipeline. No edit to the [slug] route.
		const newPath = "/src/content/blog/third-post.md";
		site.write(newPath, enc("---\ntitle: The Third\n---\nthird body\n"));
		await coordinator.notifyChanged({ kind: "write", path: newPath, hash: "third-hash" });

		const third = await handler.fetch(new Request("https://app/blog/third-post"));
		expect(third.status, await third.clone().text()).toBe(200);
		const thirdHtml = await third.text();
		expect(thirdHtml).toContain("The Third");
		expect(thirdHtml).toContain("third body");

		// The list page re-bakes too.
		const list = await handler.fetch(new Request("https://app/blog"));
		expect(await list.text()).toContain("The Third");
	});
});
