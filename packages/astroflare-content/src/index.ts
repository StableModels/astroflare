/**
 * @astroflare/content — content collections (Tier 1, §3 of the brief).
 *
 * Mirrors Astro's `astro:content` API surface:
 *   - `defineCollection({ schema })` — declare a typed collection
 *   - `getCollection(name)` — read all entries (slug, data, body)
 *   - `getEntry(name, slug)` — single entry
 *
 * Storage layout is Astro's: each collection is a directory under
 * `/src/content/<name>/`, each `.md` file is one entry. The file's
 * frontmatter is parsed as YAML and validated against the collection's Zod
 * schema; the body is exposed as the entry's `body` field for downstream
 * rendering.
 *
 * Phase 14 update: `.mdx` entries land alongside `.md`. The same
 * frontmatter / Zod-validation / slug derivation rules apply.
 *
 * Carve-outs (in retro):
 *   - Content-layer custom loaders (`loader: () => …`) — Astro's API for
 *     fetching from non-filesystem sources; the schema is in place but
 *     wiring is deferred.
 *   - Reference / image fields in schemas — Zod just sees them as strings
 *     for now; resolution happens at the consumer level.
 *   - Slug derivation conventions (Astro lets users override slug via
 *     `slug` in frontmatter, or via filename; we always use filename).
 */

import { type Storage, contentId } from "@astroflare/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Re-export Zod so users can do `import { z } from "@astroflare/content"`
// without adding zod as their own dep — Astro does the same.
export { z };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const dec = new TextDecoder();
const COLLECTIONS_PREFIX = "/src/content";
// Order matters: `.mdx` is checked first so a file matching both suffixes
// (rare but possible during migration) resolves the longer extension.
const ENTRY_EXTENSIONS = [".mdx", ".md"] as const;

export interface CollectionDefinition<T extends z.ZodTypeAny = z.ZodTypeAny> {
	type?: "content" | "data";
	schema?: T;
}

export interface DefinedCollection<T extends z.ZodTypeAny = z.ZodTypeAny> {
	type: "content" | "data";
	schema: T | undefined;
}

/**
 * `defineCollection({ schema })` — Astro-shaped helper. Identity at runtime
 * (so users can `defineCollection({ schema: z.object({…}) })` and have the
 * inferred entry type), with the `type` defaulting to `"content"`.
 */
export function defineCollection<T extends z.ZodTypeAny>(
	def: CollectionDefinition<T>,
): DefinedCollection<T> {
	return {
		type: def.type ?? "content",
		schema: def.schema,
	};
}

export interface CollectionEntry<TData = Record<string, unknown>> {
	/** Slug derived from the filename (e.g. `posts/hello.md` → `"hello"`). */
	slug: string;
	/** Workspace path of the entry file. */
	id: string;
	/** Validated frontmatter. */
	data: TData;
	/** Raw markdown body (after frontmatter). */
	body: string;
	/** Content hash of the entry's source bytes. */
	digest: string;
}

export interface CollectionRegistry {
	/** Map of collection-name → DefinedCollection. */
	collections: Record<string, DefinedCollection>;
}

/**
 * Build a content-collection reader bound to a `Storage` and a registry.
 * Returns the public `getCollection`/`getEntry` API.
 */
export function createContentReader(storage: Storage, registry: CollectionRegistry) {
	async function getCollection<TData = Record<string, unknown>>(
		name: string,
	): Promise<CollectionEntry<TData>[]> {
		const def = registry.collections[name];
		if (!def) {
			throw new Error(`getCollection("${name}"): no such collection registered`);
		}
		const out: CollectionEntry<TData>[] = [];
		for (const ext of ENTRY_EXTENSIONS) {
			for await (const filePath of storage.glob(`${COLLECTIONS_PREFIX}/${name}/**/*${ext}`)) {
				const entry = await loadEntry<TData>(storage, name, filePath, def);
				out.push(entry);
			}
		}
		out.sort((a, b) => a.slug.localeCompare(b.slug));
		return out;
	}

	async function getEntry<TData = Record<string, unknown>>(
		name: string,
		slug: string,
	): Promise<CollectionEntry<TData> | null> {
		const def = registry.collections[name];
		if (!def) {
			throw new Error(`getEntry("${name}", ...): no such collection registered`);
		}
		for (const ext of ENTRY_EXTENSIONS) {
			const filePath = `${COLLECTIONS_PREFIX}/${name}/${slug}${ext}`;
			const stat = await storage.stat(filePath);
			if (stat) return loadEntry<TData>(storage, name, filePath, def);
		}
		return null;
	}

	return { getCollection, getEntry };
}

async function loadEntry<TData>(
	storage: Storage,
	collectionName: string,
	filePath: string,
	def: DefinedCollection,
): Promise<CollectionEntry<TData>> {
	const bytes = await storage.read(filePath);
	const source = dec.decode(bytes);
	const digest = await contentId(bytes);

	let data: Record<string, unknown> = {};
	let body = source;
	const m = FRONTMATTER_RE.exec(source);
	if (m) {
		try {
			const parsed = parseYaml(m[1] as string);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				data = parsed as Record<string, unknown>;
			}
		} catch (err) {
			throw new Error(
				`content collection "${collectionName}": invalid YAML in ${filePath}: ${
					(err as Error).message
				}`,
			);
		}
		body = source.slice(m[0].length);
	}

	if (def.schema) {
		const result = def.schema.safeParse(data);
		if (!result.success) {
			throw new Error(
				`content collection "${collectionName}": ${filePath} failed schema:\n${result.error.issues
					.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
					.join("\n")}`,
			);
		}
		data = result.data;
	}

	const slug = slugFor(collectionName, filePath);
	return {
		slug,
		id: filePath,
		data: data as TData,
		body,
		digest,
	};
}

function slugFor(collectionName: string, filePath: string): string {
	const prefix = `${COLLECTIONS_PREFIX}/${collectionName}/`;
	if (!filePath.startsWith(prefix)) return "";
	let rel = filePath.slice(prefix.length);
	for (const ext of ENTRY_EXTENSIONS) {
		if (rel.endsWith(ext)) {
			rel = rel.slice(0, -ext.length);
			break;
		}
	}
	return rel;
}
