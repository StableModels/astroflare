/**
 * `createContentRuntimeModule` — the host-side content bake (feature:
 * host-driven content collections for Mode A preview + Mode B workers
 * build).
 *
 * The problem it solves: `createContentReader` needs a `Site`
 * capability, but the spawned compile/render isolate has none, and the
 * inline bundler only walks `.astro`/`.md`/`.mdx` imports — so a bare
 * `import { getCollection } from "astro:content"` in `.astro`
 * frontmatter (or `getStaticPaths()`) can't resolve to anything
 * callable. See the header of `./index.ts` for the long-form analysis.
 *
 * The fix is the seam the framework already trusts for
 * `@astroflare/runtime/*`: inject a fully-resolved module into the
 * isolate. This helper does the fragile work host-side (glob,
 * frontmatter YAML, slug/digest derivation) against the host's `Site`,
 * freezes the result into a serialisable snapshot, and emits a small
 * ESM exposing **synchronous** collection accessors closed over that
 * snapshot. `@astroflare/preview/bundle`'s inline bundler rewrites
 * `astro:content` / `@astroflare/content` imports to bind against it.
 *
 * Because it is *data*, not a capability, the generated module
 * resolves identically inside `getStaticPaths()` and frontmatter, and
 * the same `{ source, digest }` is consumed by both
 * `createPreviewHandler` (Mode A) and the workers `buildSite`
 * (Mode B) — so preview ↔ publish stay in lock-step. The `digest` is
 * folded into the per-bundle execution cache key by both callers so a
 * stale isolate is never reused after content changes.
 *
 * v1 contract — **schema-less auto-discovery**: every directory under
 * `/src/content/<name>/` is a collection, each `.md`/`.mdx` is an
 * entry, `entry.data` is the parsed frontmatter as-is. No `config.ts`
 * evaluation (that would mean sandboxed eval of arbitrary user TS in a
 * Worker — deliberately deferred; see the issue's "Schema scope").
 */

import { type Site, contentId, stableStringify } from "@astroflare/core";
import { type CollectionEntry, createContentReader, defineCollection } from "./index.js";

const CONTENT_PREFIX = "/src/content";
const ENTRY_EXTENSIONS = [".md", ".mdx"] as const;

/** Serialisable, frozen view of every collection. Keyed by name. */
export type ContentSnapshot = Record<string, CollectionEntry[]>;

export interface ContentRuntimeModule {
	/**
	 * ESM source exposing synchronous `getCollection` / `getEntry`
	 * closed over the baked snapshot. Injected into the spawned isolate
	 * as `content.js` (see `buildClosureRenderTask`); the inline bundler
	 * binds `astro:content` / `@astroflare/content` imports against it.
	 */
	source: string;
	/**
	 * Combined digest of the snapshot. Callers fold this into the
	 * per-bundle execution cache key so a content add/edit/delete busts
	 * the isolate cache even though the route's `.astro` closure didn't
	 * change.
	 */
	digest: string;
}

/**
 * Bake every content collection reachable through `site` into an
 * injectable runtime module. Returns `null` when `/src/content/`
 * carries no entries — callers treat that as "no content module,
 * nothing to inject" so the feature is zero-cost when unused.
 */
export async function createContentRuntimeModule(site: Site): Promise<ContentRuntimeModule | null> {
	const collectionNames = new Set<string>();
	for (const ext of ENTRY_EXTENSIONS) {
		for await (const path of site.glob(`${CONTENT_PREFIX}/**/*${ext}`)) {
			const name = collectionNameFor(path);
			if (name) collectionNames.add(name);
		}
	}
	if (collectionNames.size === 0) return null;

	const sortedNames = Array.from(collectionNames).sort();
	const registry = {
		collections: Object.fromEntries(sortedNames.map((n) => [n, defineCollection({})])),
	};
	const reader = createContentReader(site, registry);

	const snapshot: ContentSnapshot = {};
	for (const name of sortedNames) {
		snapshot[name] = await reader.getCollection(name);
	}

	const digest = await contentId(stableStringify(snapshot));
	return { source: renderModuleSource(snapshot), digest };
}

/**
 * `/src/content/blog/hello.md` → `"blog"`;
 * `/src/content/blog/nested/p.md` → `"blog"`;
 * `/src/content/loose.md` → `null` (a file directly under
 * `/src/content/` is not a collection entry — Astro's convention).
 */
function collectionNameFor(path: string): string | null {
	const prefix = `${CONTENT_PREFIX}/`;
	if (!path.startsWith(prefix)) return null;
	const rest = path.slice(prefix.length);
	const slash = rest.indexOf("/");
	if (slash <= 0) return null;
	return rest.slice(0, slash);
}

/**
 * Emit the injectable ESM. Accessors are synchronous (the data is
 * already resolved) but callers `await getCollection(...)` per Astro's
 * API — awaiting a non-promise resolves immediately, so the canonical
 * pattern works unmodified. `getEntry` accepts both Astro shapes:
 * `getEntry(collection, slug)` and `getEntry({ collection, slug })`.
 * `defineCollection` is an identity stub so a stray `import
 * { defineCollection } from "astro:content"` in a page doesn't crash —
 * schemas stay host-side in v1.
 */
function renderModuleSource(snapshot: ContentSnapshot): string {
	return [
		`const __SNAPSHOT = ${JSON.stringify(snapshot)};`,
		"export function getCollection(name, filter) {",
		"  const all = __SNAPSHOT[name] ?? [];",
		'  return typeof filter === "function" ? all.filter(filter) : all;',
		"}",
		"export function getEntry(a, b) {",
		"  let name, slug;",
		'  if (a && typeof a === "object") { name = a.collection; slug = a.slug ?? a.id; }',
		"  else { name = a; slug = b; }",
		"  const all = __SNAPSHOT[name] ?? [];",
		"  return all.find((e) => e.slug === slug || e.id === slug) ?? null;",
		"}",
		"export function getCollectionNames() { return Object.keys(__SNAPSHOT); }",
		"export function defineCollection(d) { return d; }",
		"",
	].join("\n");
}
