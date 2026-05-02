import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type TestHost, createTestHost } from "@astroflare/test-utils";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	createDeployServer,
	deploy,
	outputPathFor,
	plan,
	readCurrent,
	readManifest,
} from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIST = path.resolve(__dirname, "../../astroflare-runtime/dist/index.js");
const RUNTIME_URL = pathToFileURL(RUNTIME_DIST).href;

const enc = (s: string) => new TextEncoder().encode(s);

beforeAll(() => {
	if (!existsSync(RUNTIME_DIST)) {
		throw new Error(`Runtime dist not found at ${RUNTIME_DIST}. Run pnpm typecheck.`);
	}
});

const active: TestHost[] = [];
afterEach(async () => {
	await Promise.all(active.splice(0).map((h) => h.dispose()));
});

async function fixture(files: Record<string, string>): Promise<TestHost> {
	const host = createTestHost();
	active.push(host);
	for (const [p, body] of Object.entries(files)) await host.storage.write(p, enc(body));
	return host;
}

// -----------------------------------------------------------------------------
// outputPathFor
// -----------------------------------------------------------------------------

describe("outputPathFor", () => {
	it.each([
		["/src/pages/index.astro", "index.html"],
		["/src/pages/about.astro", "about/index.html"],
		["/src/pages/posts/hello.md", "posts/hello/index.html"],
		["/src/pages/posts/index.astro", "posts/index.html"],
	])("%s → %s", (input, want) => {
		expect(outputPathFor(input)).toBe(want);
	});
});

// -----------------------------------------------------------------------------
// plan()
// -----------------------------------------------------------------------------

describe("plan", () => {
	it("classifies static and dynamic routes", async () => {
		const host = await fixture({
			"/src/pages/index.astro": "<p>home</p>",
			"/src/pages/about.astro": "<p>about</p>",
			"/src/pages/posts/[slug].astro": "<p>post</p>",
			"/src/pages/blog.md": "# blog",
		});
		const p = await plan(host.storage);
		expect(p.staticCount).toBe(3);
		expect(p.skippedCount).toBe(1);
		const skipped = p.routes.find((r) => r.kind === "skipped");
		expect(skipped?.route.filePath).toBe("/src/pages/posts/[slug].astro");
	});
});

// -----------------------------------------------------------------------------
// deploy()
// -----------------------------------------------------------------------------

describe("deploy", () => {
	it("renders all static routes to /site/<deployHash>/...", async () => {
		const host = await fixture({
			"/src/pages/index.astro": "<p>home</p>",
			"/src/pages/about.astro": "<p>about</p>",
			"/src/pages/posts/hello.md": "---\ntitle: Hi\n---\n# Hello\n",
		});

		const result = await deploy({
			host,
			runtimeImport: RUNTIME_URL,
			now: () => 1700000000000,
		});

		expect(result.rendered).toHaveLength(3);
		expect(result.skipped).toHaveLength(0);
		expect(result.deployHash).toMatch(/^[a-f0-9]+$/);

		// Each route's HTML lives at /site/<deployHash>/<output-path>.
		for (const r of result.rendered) {
			expect(r.storagePath).toContain(result.deployHash);
			const stat = await host.storage.stat(r.storagePath);
			expect(stat).not.toBeNull();
		}

		// Manifest written.
		const m = await readManifest(host.storage, result.deployHash);
		expect(m).not.toBeNull();
		expect(m?.routes.map((r) => r.url).sort()).toEqual(["/", "/about", "/posts/hello"]);

		// Atomic flip.
		expect(await readCurrent(host.storage)).toBe(result.deployHash);
	});

	it("skips dynamic routes and reports them in the result", async () => {
		const host = await fixture({
			"/src/pages/index.astro": "<p>home</p>",
			"/src/pages/[slug].astro": "<p>dynamic</p>",
		});
		const result = await deploy({ host, runtimeImport: RUNTIME_URL });
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]?.kind).toBe("skipped");
	});

	it("rendered HTML matches what the preview would produce", async () => {
		const host = await fixture({
			"/src/pages/index.astro": "---\nconst n = 1+2;\n---\n<p>n={n}</p>",
		});
		const result = await deploy({ host, runtimeImport: RUNTIME_URL });
		const r = result.rendered[0];
		expect(r?.html).toContain("<p>n=3</p>");
	});

	it("includes manifest digests for each route", async () => {
		const host = await fixture({
			"/src/pages/index.astro": "<p>x</p>",
		});
		const result = await deploy({ host, runtimeImport: RUNTIME_URL });
		expect(result.manifest.routes[0]?.digest).toMatch(/^[a-f0-9]+$/);
	});
});

// -----------------------------------------------------------------------------
// createDeployServer
// -----------------------------------------------------------------------------

describe("createDeployServer", () => {
	it("returns 503 when no deploy is current", async () => {
		const host = await fixture({});
		const server = createDeployServer({ host });
		const r = await server.fetch(new Request("https://app/"));
		expect(r.status).toBe(503);
	});

	it("serves rendered HTML for matching paths", async () => {
		const host = await fixture({
			"/src/pages/index.astro": "<p>home</p>",
			"/src/pages/about.astro": "<p>about</p>",
		});
		await deploy({ host, runtimeImport: RUNTIME_URL });
		const server = createDeployServer({ host });

		const r1 = await server.fetch(new Request("https://app/"));
		expect(r1.status).toBe(200);
		expect(r1.headers.get("content-type")).toMatch(/text\/html/);
		expect(await r1.text()).toContain("<p>home</p>");

		const r2 = await server.fetch(new Request("https://app/about"));
		expect(r2.status).toBe(200);
		expect(await r2.text()).toContain("<p>about</p>");

		// Trailing slash
		const r3 = await server.fetch(new Request("https://app/about/"));
		expect(r3.status).toBe(200);
		expect(await r3.text()).toContain("<p>about</p>");
	});

	it("returns 404 for unmatched URLs", async () => {
		const host = await fixture({
			"/src/pages/index.astro": "<p>home</p>",
		});
		await deploy({ host, runtimeImport: RUNTIME_URL });
		const server = createDeployServer({ host });
		const r = await server.fetch(new Request("https://app/missing"));
		expect(r.status).toBe(404);
	});

	it("supports rolling forward to a new deploy via flipCurrent", async () => {
		const host = await fixture({
			"/src/pages/index.astro": "<p>v1</p>",
		});
		await deploy({ host, runtimeImport: RUNTIME_URL });
		const server = createDeployServer({ host });

		const r1 = await server.fetch(new Request("https://app/"));
		expect(await r1.text()).toContain("<p>v1</p>");

		await host.storage.write("/src/pages/index.astro", enc("<p>v2</p>"));
		await deploy({ host, runtimeImport: RUNTIME_URL });

		const r2 = await server.fetch(new Request("https://app/"));
		expect(await r2.text()).toContain("<p>v2</p>");
	});

	it("supports rollback by flipping /site/current to a previous deploy", async () => {
		const host = await fixture({
			"/src/pages/index.astro": "<p>v1</p>",
		});
		const v1 = await deploy({ host, runtimeImport: RUNTIME_URL });
		await host.storage.write("/src/pages/index.astro", enc("<p>v2</p>"));
		await deploy({ host, runtimeImport: RUNTIME_URL });

		// Roll back: write /site/current to v1's hash.
		await host.storage.write("/site/current", enc(v1.deployHash));
		const server = createDeployServer({ host });
		const r = await server.fetch(new Request("https://app/"));
		expect(await r.text()).toContain("<p>v1</p>");
	});
});
