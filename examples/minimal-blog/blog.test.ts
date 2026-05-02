/**
 * minimal-blog end-to-end exercise.
 *
 * Boots the Phase 1 in-memory test host, populates it with the fixture
 * tree, runs the Phase 3+ preview server, asserts:
 *   - the index renders inside the layout
 *   - the markdown about page renders to HTML
 *   - dynamic [slug] routes work
 *   - content collections enumerate the schema-validated blog entries
 *
 * Plus a deploy run that produces static HTML for everything except the
 * dynamic route (which Phase 7 explicitly skips until getStaticPaths
 * ships).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDeployServer, deploy } from "@astroflare/build";
import { createContentReader, defineCollection, z } from "@astroflare/content";
import { createPreviewServer } from "@astroflare/preview";
import { type TestHost, createTestHost } from "@astroflare/test-utils";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { minimalBlogFiles } from "./fixture.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIST = path.resolve(__dirname, "../../packages/astroflare-runtime/dist/index.js");
const RUNTIME_URL = pathToFileURL(RUNTIME_DIST).href;

const enc = (s: string) => new TextEncoder().encode(s);

beforeAll(() => {
	if (!existsSync(RUNTIME_DIST)) {
		throw new Error(`Runtime dist not found at ${RUNTIME_DIST}.`);
	}
});

const active: TestHost[] = [];
afterEach(async () => {
	await Promise.all(active.splice(0).map((h) => h.dispose()));
});

async function bootHost(): Promise<TestHost> {
	const host = createTestHost();
	active.push(host);
	for (const [p, body] of Object.entries(minimalBlogFiles)) {
		await host.storage.write(p, enc(body));
	}
	return host;
}

function stripHmr(html: string): string {
	return html.replace(/<script type="module">[\s\S]*?<\/script>/g, "");
}

describe("minimal-blog: preview", () => {
	it("renders the index page inside the layout", async () => {
		const host = await bootHost();
		const server = createPreviewServer({
			config: { site: "https://blog.example" },
			host,
			runtimeImport: RUNTIME_URL,
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(r.status).toBe(200);
		const body = stripHmr(await r.text());
		expect(body).toContain("<title>My Blog</title>");
		expect(body).toContain("<h1>Welcome</h1>");
		expect(body).toContain("astroflare"); // footer from layout
	});

	it("renders markdown pages", async () => {
		const host = await bootHost();
		const server = createPreviewServer({
			config: {},
			host,
			runtimeImport: RUNTIME_URL,
		});
		const r = await server.fetch(new Request("https://app/about"));
		expect(r.status).toBe(200);
		const body = stripHmr(await r.text());
		expect(body).toContain("<h1>About this blog</h1>");
	});

	it("renders dynamic [slug] post pages with the layout", async () => {
		const host = await bootHost();
		const server = createPreviewServer({
			config: {},
			host,
			runtimeImport: RUNTIME_URL,
		});
		const r = await server.fetch(new Request("https://app/posts/hello-world"));
		expect(r.status).toBe(200);
		const body = stripHmr(await r.text());
		expect(body).toContain("<title>hello-world</title>");
		expect(body).toContain("<h1>hello-world</h1>");
	});
});

describe("minimal-blog: content collections", () => {
	it("getCollection returns schema-validated blog entries", async () => {
		const host = await bootHost();

		const blog = defineCollection({
			schema: z.object({
				title: z.string(),
				pubDate: z.string().or(z.date()),
				tags: z.array(z.string()).default([]),
			}),
		});
		const reader = createContentReader(host.storage, {
			collections: { blog },
		});

		const all = await reader.getCollection<{ title: string; tags: string[] }>("blog");
		expect(all).toHaveLength(3);
		expect(all.map((e) => e.slug)).toEqual(["hello-world", "second-post", "third-post"]);
		expect(all[0]?.data.title).toBe("Hello, World");
		expect(all[0]?.data.tags).toEqual(["intro", "hello"]);
	});
});

describe("minimal-blog: deploy", () => {
	it("renders all static routes; skips the dynamic post route", async () => {
		const host = await bootHost();

		const result = await deploy({ host, runtimeImport: RUNTIME_URL });

		const urls = result.manifest.routes.map((r) => r.url).sort();
		expect(urls).toEqual(["/", "/about"]);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]?.kind).toBe("skipped");

		// The deploy server serves the static HTML.
		const ds = createDeployServer({ host });
		const r = await ds.fetch(new Request("https://app/about"));
		expect(r.status).toBe(200);
		expect(await r.text()).toContain("<h1>About this blog</h1>");
	});
});
