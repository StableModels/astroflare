import { MemoryStorage } from "@astroflare/test-utils";
import { describe, expect, it } from "vitest";
import { createContentReader, defineCollection, z } from "./index.js";

const enc = (s: string) => new TextEncoder().encode(s);

async function fixture(files: Record<string, string>): Promise<MemoryStorage> {
	const s = new MemoryStorage();
	for (const [p, body] of Object.entries(files)) await s.write(p, enc(body));
	return s;
}

const blogSchema = z.object({
	title: z.string(),
	pubDate: z.string().optional(),
	tags: z.array(z.string()).default([]),
});

describe("defineCollection", () => {
	it("defaults type to 'content'", () => {
		const c = defineCollection({ schema: blogSchema });
		expect(c.type).toBe("content");
		expect(c.schema).toBe(blogSchema);
	});

	it("respects an explicit type", () => {
		const c = defineCollection({ type: "data" });
		expect(c.type).toBe("data");
	});
});

describe("getCollection", () => {
	it("loads every entry under /src/content/<name>/", async () => {
		const storage = await fixture({
			"/src/content/blog/hello.md": "---\ntitle: Hello\n---\nBody A",
			"/src/content/blog/world.md": "---\ntitle: World\n---\nBody B",
		});
		const reader = createContentReader(storage, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});
		const all = await reader.getCollection("blog");
		expect(all).toHaveLength(2);
		expect(all.map((e) => e.slug).sort()).toEqual(["hello", "world"]);
		expect(all[0]?.data.title).toBeDefined();
	});

	it("validates against the Zod schema and applies defaults", async () => {
		const storage = await fixture({
			"/src/content/blog/post.md": "---\ntitle: With Defaults\n---\nbody",
		});
		const reader = createContentReader(storage, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});
		const [entry] = await reader.getCollection("blog");
		expect(entry?.data.tags).toEqual([]);
	});

	it("throws on schema-failure with file path + path-of-issue", async () => {
		const storage = await fixture({
			"/src/content/blog/bad.md": "---\nnoTitle: oops\n---\nbody",
		});
		const reader = createContentReader(storage, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});
		await expect(reader.getCollection("blog")).rejects.toThrow(/title/);
	});

	it("throws on invalid YAML", async () => {
		const storage = await fixture({
			"/src/content/blog/bad.md": "---\n: nope:\n---\nbody",
		});
		const reader = createContentReader(storage, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});
		await expect(reader.getCollection("blog")).rejects.toThrow(/invalid YAML/);
	});

	it("throws on unknown collection", async () => {
		const storage = await fixture({});
		const reader = createContentReader(storage, { collections: {} });
		await expect(reader.getCollection("missing")).rejects.toThrow(/no such collection/);
	});

	it("returns an empty array for an empty collection", async () => {
		const storage = await fixture({});
		const reader = createContentReader(storage, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});
		expect(await reader.getCollection("blog")).toEqual([]);
	});

	it("derives slugs from nested file paths", async () => {
		const storage = await fixture({
			"/src/content/docs/intro/getting-started.md": "---\ntitle: GS\n---\nb",
		});
		const reader = createContentReader(storage, {
			collections: {
				docs: defineCollection({ schema: z.object({ title: z.string() }) }),
			},
		});
		const [entry] = await reader.getCollection("docs");
		expect(entry?.slug).toBe("intro/getting-started");
	});

	it("populates body and digest", async () => {
		const storage = await fixture({
			"/src/content/blog/post.md": "---\ntitle: T\n---\nthe body",
		});
		const reader = createContentReader(storage, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});
		const [entry] = await reader.getCollection("blog");
		expect(entry?.body).toBe("the body");
		expect(entry?.digest).toMatch(/^[a-f0-9]+$/);
	});

	it("reads .mdx entries alongside .md (Phase 14)", async () => {
		const storage = await fixture({
			"/src/content/blog/plain.md": "---\ntitle: Plain\n---\nbody A",
			"/src/content/blog/jsx.mdx": "---\ntitle: JSX\n---\n# body B\n\n<button>x</button>\n",
		});
		const reader = createContentReader(storage, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});
		const all = await reader.getCollection("blog");
		expect(all.map((e) => e.slug).sort()).toEqual(["jsx", "plain"]);
		const jsx = all.find((e) => e.slug === "jsx");
		expect(jsx?.data.title).toBe("JSX");
		// Body preserved as-is (MDX compilation happens in the route layer).
		expect(jsx?.body).toContain("<button>x</button>");
	});
});

describe("getEntry", () => {
	it("returns a single entry by slug", async () => {
		const storage = await fixture({
			"/src/content/blog/hello.md": "---\ntitle: Hello\n---\nBody",
			"/src/content/blog/world.md": "---\ntitle: World\n---\nBody",
		});
		const reader = createContentReader(storage, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});
		const e = await reader.getEntry("blog", "hello");
		expect(e?.data.title).toBe("Hello");
	});

	it("returns null for a missing slug", async () => {
		const storage = await fixture({
			"/src/content/blog/hello.md": "---\ntitle: Hello\n---\nBody",
		});
		const reader = createContentReader(storage, {
			collections: { blog: defineCollection({ schema: blogSchema }) },
		});
		expect(await reader.getEntry("blog", "no-such-slug")).toBeNull();
	});
});
