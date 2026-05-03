/**
 * `createPreviewHandler` integration test — exercises the closure-
 * walking pipeline against a workerd-backed executor with the canonical
 * `@astroflare/starter` scaffold.
 *
 * Confirms the gap fix:
 *   - a route that imports a layout renders with the layout's chrome
 *   - markdown routes through the layout work
 *   - dynamic `[slug]` routes (no `getStaticPaths` evaluation, but the
 *     router still matches and `Astro.params` populates) render
 *   - mutating a layout + `coordinator.notifyChanged` re-renders the
 *     page with the new layout (cache invalidation works because
 *     `bundleKey` derives from every module's compileKey)
 */

import { env } from "cloudflare:test";
import { getStarterFiles } from "@astroflare/starter";
import { MemoryCache, MemorySite } from "@astroflare/test-utils/in-memory";
import { describe, expect, it } from "vitest";
import { createCoordinator } from "./coordinator.js";
import { createPreviewHandler } from "./preview-handler.js";
import { createWorkerdExecutor } from "./runtime-bundled-executor.js";
import { runtimeModules } from "./runtime-modules.js";
import type { SqlBackend } from "./sql-cache.js";

/**
 * In-memory `SqlBackend` mock covering the queries `createCoordinator`
 * issues. Same shape as `coordinator.test.ts`'s mock — pulled inline
 * here so this test stays self-contained.
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
				const ib = ensure("aflare_module_imported_by");
				const path = bindings[0] as string;
				for (const k of Array.from(ib.keys())) {
					if (k.startsWith(`${path}|`)) ib.delete(k);
				}
				return { toArray: () => [] };
			}
			throw new Error(`unhandled query: ${q.slice(0, 80)}`);
		},
	};
}

interface Harness {
	site: MemorySite;
	cache: MemoryCache;
	coordinator: ReturnType<typeof createCoordinator>;
	handler: ReturnType<typeof createPreviewHandler>;
}

function bootHarness(): Harness {
	const site = new MemorySite();
	const enc = new TextEncoder();
	for (const [path, bytes] of Object.entries(getStarterFiles())) {
		site.write(`/${path}`, bytes);
	}
	// Shiki (the default markdown syntax-highlighter) loads WebAssembly,
	// which workerd's test pool can't compile. Replace the starter's
	// `about.md` with a code-block-free variant so the markdown render
	// path stays exercised without dragging Shiki in. The body is what
	// the test asserts on.
	site.write(
		"/src/pages/about.md",
		enc.encode(
			"---\ntitle: About\n---\n\n# About this site\n\nThis page is rendered from a markdown file.\n",
		),
	);
	const cache = new MemoryCache();
	const sql = makeMockSql();
	const coordinator = createCoordinator({ sql });
	const executor = createWorkerdExecutor({
		loader: env.LOADER,
		compatibilityDate: "2025-09-01",
		compatibilityFlags: ["nodejs_compat"],
		runtime: runtimeModules,
	});
	const handler = createPreviewHandler({
		site,
		coordinator,
		executor,
		cache,
	});
	return { site, cache, coordinator, handler };
}

describe("createPreviewHandler: closure walking with the starter scaffold", () => {
	it("renders the index route inside the Base layout", async () => {
		const { handler } = bootHarness();
		const res = await handler.fetch(new Request("https://app/"));
		expect(res.status, await res.clone().text()).toBe(200);
		const html = await res.text();
		// page-level interpolation
		expect(html).toContain("Welcome to your new Astroflare site");
		// layout-supplied chrome (`<title>` set by Base.astro from `Astro.props.title`)
		expect(html).toContain("<title>Home</title>");
		// layout footer
		expect(html).toContain("built with astroflare");
	});

	it("renders the markdown about page", async () => {
		const { handler } = bootHarness();
		const res = await handler.fetch(new Request("https://app/about"));
		expect(res.status, await res.clone().text()).toBe(200);
		const html = await res.text();
		expect(html).toContain("About this site");
	});

	it("renders the dynamic [slug] route through the layout", async () => {
		const { handler } = bootHarness();
		const res = await handler.fetch(new Request("https://app/posts/hello-world"));
		expect(res.status, await res.clone().text()).toBe(200);
		const html = await res.text();
		// page reads `Astro.params.slug`; the slug comes from the
		// router's param extraction.
		expect(html).toContain("hello-world");
		// layout chrome is also present (proves we walked through the
		// Base layout despite the route being dynamic).
		expect(html).toContain("built with astroflare");
	});

	it("picks up layout edits after coordinator.notifyChanged", async () => {
		const { site, coordinator, handler } = bootHarness();

		const before = await handler.fetch(new Request("https://app/"));
		const beforeText = await before.text();
		expect(beforeText).toContain("built with astroflare");
		expect(beforeText).not.toContain("MUTATED-FOOTER");

		// Mutate the layout's footer.
		const layoutPath = "/src/layouts/Base.astro";
		const updated = `---
const { title } = Astro.props;
---
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>{title}</title>
	</head>
	<body>
		<header><a href="/">home</a></header>
		<main><slot /></main>
		<footer>MUTATED-FOOTER</footer>
	</body>
</html>
`;
		const enc = new TextEncoder();
		site.write(layoutPath, enc.encode(updated));
		// Match what `WorkspaceSite.write` would do post-write: hand a
		// SiteChangeEvent to the coordinator so reverse-edge HMR walks
		// run + future renders see the change.
		await coordinator.notifyChanged({
			kind: "write",
			path: layoutPath,
			hash: "mutated",
		});

		const after = await handler.fetch(new Request("https://app/"));
		const afterText = await after.text();
		expect(after.status).toBe(200);
		expect(afterText).toContain("MUTATED-FOOTER");
	});
});
