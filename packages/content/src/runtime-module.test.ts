import { MemorySite } from "@astroflare/test-utils";
import { describe, expect, it } from "vitest";
import { createContentRuntimeModule } from "./runtime-module.js";

const enc = (s: string) => new TextEncoder().encode(s);

function siteWith(files: Record<string, string>): MemorySite {
	const s = new MemorySite();
	for (const [p, body] of Object.entries(files)) s.write(p, enc(body));
	return s;
}

/**
 * Evaluate the generated module source the same way the spawned
 * isolate would — as a real ESM — and hand back its exports.
 */
async function loadModule(source: string): Promise<{
	getCollection: (name: string, filter?: (e: unknown) => boolean) => unknown[];
	getEntry: (a: unknown, b?: unknown) => unknown;
	getCollectionNames: () => string[];
	defineCollection: (d: unknown) => unknown;
}> {
	const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
	return import(/* @vite-ignore */ url);
}

const BLOG = {
	"/src/content/blog/hello-world.md":
		"---\ntitle: Hello, World\npubDate: 2026-05-02\ntags: [intro, hello]\n---\n# Hello!\n",
	"/src/content/blog/second-post.md":
		"---\ntitle: A Second Post\npubDate: 2026-05-09\n---\n# Second\n",
};

describe("createContentRuntimeModule", () => {
	it("returns null when there is no /src/content/", async () => {
		const site = siteWith({ "/src/pages/index.astro": "---\n---\n<h1>hi</h1>" });
		expect(await createContentRuntimeModule(site)).toBeNull();
	});

	it("returns null when /src/content/ has only loose files (no collection dir)", async () => {
		// A `.md` directly under /src/content/ is not a collection entry.
		const site = siteWith({ "/src/content/README.md": "# not a collection\n" });
		expect(await createContentRuntimeModule(site)).toBeNull();
	});

	it("bakes a schema-less snapshot exposing CollectionEntry fields", async () => {
		const site = siteWith(BLOG);
		const mod = await createContentRuntimeModule(site);
		expect(mod).not.toBeNull();
		const { getCollection } = await loadModule((mod as { source: string }).source);

		const posts = getCollection("blog") as Array<Record<string, unknown>>;
		expect(posts.map((p) => p.slug)).toEqual(["hello-world", "second-post"]);
		const first = posts[0] as Record<string, unknown>;
		expect(first.slug).toBe("hello-world");
		expect(first.id).toBe("/src/content/blog/hello-world.md");
		expect((first.data as Record<string, unknown>).title).toBe("Hello, World");
		expect((first.data as Record<string, unknown>).tags).toEqual(["intro", "hello"]);
		expect((first.body as string).trim()).toBe("# Hello!");
		expect(typeof first.digest).toBe("string");
		expect((first.digest as string).length).toBeGreaterThan(0);
	});

	it("getCollection accepts a filter; getEntry resolves by slug and object form", async () => {
		const site = siteWith(BLOG);
		const mod = await createContentRuntimeModule(site);
		const { getCollection, getEntry } = await loadModule((mod as { source: string }).source);

		const filtered = getCollection(
			"blog",
			(e) => (e as { slug: string }).slug === "second-post",
		) as Array<Record<string, unknown>>;
		expect(filtered.map((p) => p.slug)).toEqual(["second-post"]);

		expect((getEntry("blog", "hello-world") as { slug: string }).slug).toBe("hello-world");
		expect((getEntry({ collection: "blog", slug: "second-post" }) as { slug: string }).slug).toBe(
			"second-post",
		);
		expect(getEntry("blog", "nope")).toBeNull();
		expect(getCollection("missing")).toEqual([]);
	});

	it("discovers multiple collections and nested entries; ignores loose files", async () => {
		const site = siteWith({
			...BLOG,
			"/src/content/blog/nested/deep-post.md": "---\ntitle: Deep\n---\nbody\n",
			"/src/content/authors/jane.mdx": "---\nname: Jane\n---\nbio\n",
			"/src/content/loose.md": "# ignored\n",
		});
		const mod = await createContentRuntimeModule(site);
		const { getCollectionNames, getCollection } = await loadModule(
			(mod as { source: string }).source,
		);
		expect(getCollectionNames().sort()).toEqual(["authors", "blog"]);
		expect((getCollection("blog") as Array<{ slug: string }>).map((p) => p.slug)).toEqual([
			"hello-world",
			"nested/deep-post",
			"second-post",
		]);
		expect((getCollection("authors") as Array<{ slug: string }>).map((p) => p.slug)).toEqual([
			"jane",
		]);
	});

	it("digest is stable for identical content and changes when content changes", async () => {
		const a = await createContentRuntimeModule(siteWith(BLOG));
		const b = await createContentRuntimeModule(siteWith(BLOG));
		expect(a?.digest).toBe(b?.digest);

		const c = await createContentRuntimeModule(
			siteWith({
				...BLOG,
				"/src/content/blog/third.md": "---\ntitle: Third\n---\nyo\n",
			}),
		);
		expect(c?.digest).not.toBe(a?.digest);
	});
});
