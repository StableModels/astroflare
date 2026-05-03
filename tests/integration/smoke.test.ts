/**
 * Phase 15 integration tests — Layer C (§8.C).
 *
 * Boots the full project-worker assembly over real Cloudflare primitives
 * inside Miniflare:
 *   - R2 (`FILES`) → `R2Storage`
 *   - Coordinator DO → `DurableObjectCoordinator`
 *   - HMR DO → `HibernatingHmrTransport`
 *   - Worker Loader → `WorkerdExecutor`
 *
 * Tests pre-seed R2 via `env.FILES.put` (matching the framework's
 * `R2Storage` key layout — `files/<path>`) and exercise the SSR pipeline
 * via `SELF.fetch`.
 */

import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * Pre-seed R2 with a workspace path. Mirrors `R2Storage.write`'s key
 * layout: workspace path `/src/pages/index.astro` becomes R2 key
 * `files/src/pages/index.astro`.
 */
async function seed(path: string, source: string): Promise<void> {
	const key = `files${path}`; // `/src/...` → `files/src/...`
	await env.FILES.put(key, enc(source));
}

/**
 * Wipe everything from the FILES bucket so each test starts clean.
 * R2 LIST is paginated; `DELETE` per object is the explicit wipe.
 */
async function wipeR2(): Promise<void> {
	let cursor: string | undefined;
	while (true) {
		const result: R2Objects = await env.FILES.list({ cursor });
		await Promise.all(result.objects.map((o) => env.FILES.delete(o.key)));
		if (!result.truncated) break;
		cursor = result.cursor;
	}
}

afterEach(async () => {
	await wipeR2();
});

/**
 * Strip the framework's HMR client `<script>` tag from rendered HTML so
 * test assertions can match against the user-visible body.
 */
function stripHmr(body: string): string {
	return body.replace(/<script[^>]*data-aflare-hmr[^>]*>[\s\S]*?<\/script>/, "");
}

describe("project-worker: routing", () => {
	it("renders a simple .astro index page from R2", async () => {
		await seed("/src/pages/index.astro", "<p>hello from .astro</p>");
		const r = await SELF.fetch("https://app/");
		expect(r.status).toBe(200);
		const body = stripHmr(await r.text());
		expect(body).toContain("hello from .astro");
	});

	it("renders a .md page", async () => {
		await seed(
			"/src/pages/about.md",
			"---\ntitle: About\n---\n# About this site\n\nA paragraph.\n",
		);
		const r = await SELF.fetch("https://app/about");
		expect(r.status).toBe(200);
		const body = stripHmr(await r.text());
		expect(body).toContain("<h1>About this site</h1>");
		expect(body).toContain("<p>A paragraph.</p>");
	});

	it("renders a .mdx page with inline JSX", async () => {
		await seed(
			"/src/pages/widget.mdx",
			"# MDX\n\n<button class=\"primary\">click</button>\n",
		);
		const r = await SELF.fetch("https://app/widget");
		expect(r.status).toBe(200);
		const body = stripHmr(await r.text());
		expect(body).toContain("<h1>MDX</h1>");
		expect(body).toContain('<button class="primary">click</button>');
	});

	it("returns 404 for an unmatched route", async () => {
		await seed("/src/pages/index.astro", "<p>only-index</p>");
		const r = await SELF.fetch("https://app/no-such-route");
		expect(r.status).toBe(404);
	});

	it("routes a multi-segment path", async () => {
		await seed("/src/pages/posts/hello-world.md", "# Hello World\n");
		const r = await SELF.fetch("https://app/posts/hello-world");
		expect(r.status).toBe(200);
		const body = stripHmr(await r.text());
		expect(body).toContain("<h1>Hello World</h1>");
	});

	it("composes a layout via cross-module imports", async () => {
		await seed(
			"/src/components/Layout.astro",
			"---\nconst { title } = Astro.props;\n---\n" +
				"<html><head><title>{title}</title></head><body><main><slot/></main></body></html>",
		);
		await seed(
			"/src/pages/index.astro",
			"---\n" +
				'import Layout from "../components/Layout.astro";\n' +
				"---\n" +
				'<Layout title="Home"><h1>Welcome</h1></Layout>',
		);
		const r = await SELF.fetch("https://app/");
		const body = stripHmr(await r.text());
		expect(body).toContain("<title>Home</title>");
		expect(body).toContain("<h1>Welcome</h1>");
	});
});

describe("project-worker: storage round-trip", () => {
	it("invalidates the cache when source changes", async () => {
		await seed("/src/pages/index.astro", "<p>v1</p>");
		const a = await SELF.fetch("https://app/");
		expect(stripHmr(await a.text())).toContain("v1");

		await seed("/src/pages/index.astro", "<p>v2</p>");
		const b = await SELF.fetch("https://app/");
		expect(stripHmr(await b.text())).toContain("v2");
	});

	// Phase 14's cross-module named-export hoist: a `.astro` page reads
	// `frontmatter` out of a `.md` file. Verifies the bundler's
	// COMPILABLE_IMPORT_RE rewriting works in the production-shaped
	// host (R2 storage, DO coordinator, Worker Loader executor).
	it("a .astro page can import { frontmatter } from a .md file", async () => {
		await seed(
			"/src/posts/hello.md",
			"---\ntitle: Hello, World\nauthor: Ada\n---\n# body\n",
		);
		await seed(
			"/src/pages/index.astro",
			"---\n" +
				'import { frontmatter } from "../posts/hello.md";\n' +
				"---\n" +
				"<article>" +
				"<h1>{frontmatter.title}</h1>" +
				"<p>by {frontmatter.author}</p>" +
				"</article>",
		);
		const r = await SELF.fetch("https://app/");
		expect(r.status).toBe(200);
		const body = stripHmr(await r.text());
		expect(body).toContain("<h1>Hello, World</h1>");
		expect(body).toContain("<p>by Ada</p>");
	});
});

describe("project-worker: assets", () => {
	it("serves asset URLs from R2", async () => {
		// Seed a tiny PNG (1x1 transparent — the actual bytes don't
		// matter for the route-handling test).
		const pngBytes = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
			0x49, 0x48, 0x44, 0x52,
		]);
		await env.FILES.put("files/src/assets/x.png", pngBytes.buffer);
		const r = await SELF.fetch("https://app/_aflare/asset/src/assets/x.png");
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toBe("image/png");
		expect(r.headers.get("cache-control")).toBe(
			"public, max-age=31536000, immutable",
		);
	});

	it("returns 404 for an asset URL whose file doesn't exist", async () => {
		const r = await SELF.fetch("https://app/_aflare/asset/missing.png");
		expect(r.status).toBe(404);
	});
});
