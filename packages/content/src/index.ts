/**
 * @astroflare/content — content collections (Tier 1, §3 of the brief).
 *
 * Mirrors Astro's `astro:content` API surface:
 *   - `defineCollection({ schema })` — declare a typed collection
 *   - `getCollection(name)` — read all entries (slug, data, body)
 *   - `getEntry(name, slug)` — single entry
 *
 * On-disk layout is Astro's: each collection is a directory under
 * `/src/content/<name>/`, each `.md` file is one entry. The file's
 * frontmatter is parsed as YAML and validated against the collection's Zod
 * schema; the body is exposed as the entry's `body` field for downstream
 * rendering.
 *
 * Phase 14 update: `.mdx` entries land alongside `.md`. The same
 * frontmatter / Zod-validation / slug derivation rules apply.
 *
 * ## `Site` adapter compatibility
 *
 * The reader is parametric in the `Site` capability — `glob()` +
 * `readFile()` + `statFile()`. Both `MemorySite` (test-utils) and
 * `WorkspaceSite` (re-exported from `@astroflare/host-cloudflare`,
 * the host-driven preview adapter for `@cloudflare/shell`'s
 * Workspace) are fully supported with no per-adapter quirks. Frontmatter parsing, Zod
 * validation, schema defaults, glob discovery, and HMR-style mutation
 * (write a new entry → next `getCollection` includes it) all behave
 * identically across adapters; see
 * `tests/workerd/content-collections-workspace.test.ts` for the
 * WorkspaceSite-shaped end-to-end coverage.
 *
 * ## Calling from inside `.astro` frontmatter / `getStaticPaths()`
 *
 * `createContentReader` needs a `Site`; the spawned compile/render
 * isolate has none, and the inline bundler only walks
 * `.astro`/`.md`/`.mdx` imports — so a bare `import { getCollection }
 * from "astro:content"` can't resolve there on its own. The supported
 * path is {@link createContentRuntimeModule} (see `./runtime-module.ts`,
 * re-exported below): the host bakes collections into a serialisable
 * snapshot and the framework injects a synchronous data module the
 * isolate imports. Both `createPreviewHandler` (Mode A) and the
 * workers `buildSite` (Mode B) consume the same baked module keyed
 * the same way, so preview ↔ publish stay in lock-step. Hosts opt in
 * with one call (on by default when `/src/content/` exists).
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

import { compileMarkdown } from "@astroflare/compiler";
import { type Site, contentId } from "@astroflare/core";
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

/**
 * Markdown rendering options for collection-entry bodies. Mirrors the
 * `markdown` surface threaded into the `.md`/`.mdx` *page* compiler
 * (`@astroflare/preview`'s `MarkdownOptions`, `compileMarkdown`'s
 * `shiki` flag) so an entry body and an equivalent `.md` page produce
 * byte-identical HTML — preview ↔ publish stay in lock-step. Only
 * `shiki` is exposed; the WASM Oniguruma engine is intentionally not a
 * selectable path (Workers-only rule).
 */
export interface ContentMarkdownOptions {
	/** Highlight fenced code blocks via Shiki's pure-JS regex engine. Default off. */
	shiki?: boolean;
}

export interface ContentReaderOptions {
	/**
	 * Markdown options used to pre-render every entry's body to
	 * `entry.rendered.html`. Pass the same options the host threads into
	 * the page compiler so collection bodies and `.md` pages match.
	 */
	markdown?: ContentMarkdownOptions;
}

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
	/**
	 * Body pre-rendered to HTML host-side through the framework's
	 * `.md`/`.mdx` page compiler (same remark/rehype set, same Shiki
	 * engine). Consume with Astro's standard `set:html` — `<article
	 * set:html={entry.rendered.html} />`. Deterministic from `body` +
	 * the markdown config; the snapshot digest covers it.
	 */
	rendered: { html: string };
	/** Content hash of the entry's source bytes. */
	digest: string;
}

export interface CollectionRegistry {
	/** Map of collection-name → DefinedCollection. */
	collections: Record<string, DefinedCollection>;
}

/**
 * Build a content-collection reader bound to a `Site` and a registry.
 * Returns the public `getCollection`/`getEntry` API.
 */
export function createContentReader(
	site: Site,
	registry: CollectionRegistry,
	opts: ContentReaderOptions = {},
) {
	const markdown = opts.markdown ?? {};

	async function getCollection<TData = Record<string, unknown>>(
		name: string,
	): Promise<CollectionEntry<TData>[]> {
		const def = registry.collections[name];
		if (!def) {
			throw new Error(`getCollection("${name}"): no such collection registered`);
		}
		const out: CollectionEntry<TData>[] = [];
		for (const ext of ENTRY_EXTENSIONS) {
			for await (const filePath of site.glob(`${COLLECTIONS_PREFIX}/${name}/**/*${ext}`)) {
				const entry = await loadEntry<TData>(site, name, filePath, def, markdown);
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
			const stat = await site.statFile(filePath);
			if (stat) return loadEntry<TData>(site, name, filePath, def, markdown);
		}
		return null;
	}

	return { getCollection, getEntry };
}

async function loadEntry<TData>(
	site: Site,
	collectionName: string,
	filePath: string,
	def: DefinedCollection,
	markdown: ContentMarkdownOptions,
): Promise<CollectionEntry<TData>> {
	const bytes = await site.readFile(filePath);
	if (!bytes) {
		throw new Error(`content collection "${collectionName}": missing entry ${filePath}`);
	}
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

	// Pre-render the body through the *same* compiler the host uses for
	// `.md`/`.mdx` pages. Passing the full `source` (not the sliced
	// `body`) makes `compileMarkdown` strip frontmatter with its own
	// identical regex, so an entry and an equivalent `.md` page produce
	// byte-identical HTML — and a body that legitimately begins with a
	// `---` thematic break can't be mistaken for frontmatter.
	const { html } = await compileMarkdown(source, {
		shiki: markdown.shiki === true,
		filename: filePath,
	});

	const slug = slugFor(collectionName, filePath);
	return {
		slug,
		id: filePath,
		data: data as TData,
		body,
		rendered: { html },
		digest,
	};
}

export {
	createContentRuntimeModule,
	type ContentRuntimeModule,
	type ContentSnapshot,
} from "./runtime-module.js";

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
