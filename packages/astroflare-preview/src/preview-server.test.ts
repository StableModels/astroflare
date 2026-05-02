/**
 * Phase 3 end-to-end test (Layer A).
 *
 * Substrate: in-memory `Storage`/`Coordinator`/stubs from Phase 1, plus
 * `InProcessExecutor` (Node tmp dir + dynamic `import()`). The compiler's
 * runtime import is set to a `file://` URL pointing at the runtime's
 * compiled `dist/index.js` — same pattern as the Phase 2 e2e tests.
 *
 * The pre-test `tsc -b` step (root `package.json#test`) builds the runtime
 * before this file runs, so the dist artifact exists.
 *
 * Layer C (Miniflare integration with real host) is deferred — Phase 2.5
 * showed there's no workerd-compatible Executor we can ship without
 * bypassing Miniflare. That work belongs to Phase 4 / the host package.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type TestHost, createTestHost } from "@astroflare/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PreviewServer, createPreviewServer } from "./preview-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIST = path.resolve(__dirname, "../../astroflare-runtime/dist/index.js");
const RUNTIME_URL = pathToFileURL(RUNTIME_DIST).href;

const enc = (s: string) => new TextEncoder().encode(s);

interface Fixture {
	host: TestHost;
	server: PreviewServer;
}

async function makeFixture(files: Record<string, string>): Promise<Fixture> {
	const host = createTestHost();
	for (const [p, body] of Object.entries(files)) await host.storage.write(p, enc(body));
	const server = createPreviewServer({
		config: { site: "https://example.com" },
		host,
		runtimeImport: RUNTIME_URL,
	});
	return { host, server };
}

const fixtureCleanups: TestHost[] = [];

beforeAll(() => {
	if (!existsSync(RUNTIME_DIST)) {
		throw new Error(`Runtime dist not found at ${RUNTIME_DIST}. Run \`pnpm typecheck\` first.`);
	}
});

afterAll(async () => {
	await Promise.all(fixtureCleanups.map((h) => h.dispose()));
});

async function fixture(files: Record<string, string>): Promise<Fixture> {
	const f = await makeFixture(files);
	fixtureCleanups.push(f.host);
	return f;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("preview server: routing", () => {
	it("returns 404 for an unmatched path", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<p>home</p>",
		});
		const r = await server.fetch(new Request("https://app/missing"));
		expect(r.status).toBe(404);
	});

	it("renders the index route for /", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<h1>home</h1>",
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toMatch(/text\/html/);
		expect(await r.text()).toBe("<h1>home</h1>");
	});

	it("renders a static nested route", async () => {
		const { server } = await fixture({
			"/src/pages/about.astro": "<p>about</p>",
		});
		const r = await server.fetch(new Request("https://app/about"));
		expect(await r.text()).toBe("<p>about</p>");
	});
});

// ---------------------------------------------------------------------------
// Astro.* surface
// ---------------------------------------------------------------------------

describe("preview server: Astro.* surface", () => {
	it("exposes Astro.params for [slug] dynamic routes", async () => {
		const src = "---\nconst { slug } = Astro.params;\n---\n<p>slug={slug}</p>";
		const { server } = await fixture({
			"/src/pages/posts/[slug].astro": src,
		});
		const r = await server.fetch(new Request("https://app/posts/hello-world"));
		expect(await r.text()).toBe("<p>slug=hello-world</p>");
	});

	it("exposes Astro.url and Astro.request", async () => {
		const src =
			"---\n" +
			"const u = Astro.url;\n" +
			"const m = Astro.request.method;\n" +
			"---\n" +
			"<p>{u.pathname}/{m}</p>";
		const { server } = await fixture({
			"/src/pages/about.astro": src,
		});
		const r = await server.fetch(new Request("https://app/about"));
		expect(await r.text()).toBe("<p>/about/GET</p>");
	});

	it("exposes Astro.site from config", async () => {
		const src = "---\nconst s = Astro.site;\n---\n<p>site={s}</p>";
		const { server } = await fixture({
			"/src/pages/index.astro": src,
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(await r.text()).toBe("<p>site=https://example.com</p>");
	});

	it("HTML-escapes interpolated values from Astro.params", async () => {
		const src = "---\nconst { name } = Astro.params;\n---\n<p>{name}</p>";
		const { server } = await fixture({
			"/src/pages/users/[name].astro": src,
		});
		const r = await server.fetch(new Request(`https://app/users/${encodeURIComponent("<bob>")}`));
		expect(await r.text()).toBe("<p>&lt;bob&gt;</p>");
	});
});

// ---------------------------------------------------------------------------
// Cache behaviour
// ---------------------------------------------------------------------------

describe("preview server: caching", () => {
	it("hits the executor cache on a second identical request", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": "<p>x</p>",
		});
		await server.fetch(new Request("https://app/"));
		await server.fetch(new Request("https://app/"));
		// "preview.render" event was logged twice — once per request — but the
		// underlying compile factory should only have produced one TaskBundle.
		const renders = host.logger.byName("preview.render");
		expect(renders).toHaveLength(2);
		// Both renders share the same bundleKey.
		expect(renders[0]?.fields.bundleKey).toBe(renders[1]?.fields.bundleKey);
	});

	it("uses different cache ids for different routes", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": "<p>home</p>",
			"/src/pages/about.astro": "<p>about</p>",
		});
		await server.fetch(new Request("https://app/"));
		await server.fetch(new Request("https://app/about"));
		const renders = host.logger.byName("preview.render");
		expect(renders[0]?.fields.bundleKey).not.toBe(renders[1]?.fields.bundleKey);
	});
});

// ---------------------------------------------------------------------------
// Multi-module composition (Phase 4)
// ---------------------------------------------------------------------------

describe("preview server: multi-module composition", () => {
	it("renders a page that imports a layout and a child component", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro":
				"---\n" +
				'import Layout from "../components/Layout.astro";\n' +
				'import Button from "../components/Button.astro";\n' +
				"---\n" +
				'<Layout><Button label="Click" /></Layout>',
			"/src/components/Layout.astro": "<header><slot /></header>",
			"/src/components/Button.astro":
				"---\nconst { label } = Astro.props;\n---\n<button>{label}</button>",
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(r.status).toBe(200);
		expect(await r.text()).toBe("<header><button>Click</button></header>");
	});

	it("supports diamond imports (two parents share one child)", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro":
				"---\n" +
				'import A from "../components/A.astro";\n' +
				'import B from "../components/B.astro";\n' +
				"---\n" +
				"<A/><B/>",
			"/src/components/A.astro": '---\nimport S from "./Shared.astro";\n---\n<S/>',
			"/src/components/B.astro": '---\nimport S from "./Shared.astro";\n---\n<S/>',
			"/src/components/Shared.astro": "<i>shared</i>",
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(await r.text()).toBe("<i>shared</i><i>shared</i>");
	});

	it("invalidates the bundle cache when a dep's source changes", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": '---\nimport L from "../components/L.astro";\n---\n<L/>',
			"/src/components/L.astro": "<p>v1</p>",
		});
		const r1 = await server.fetch(new Request("https://app/"));
		expect(await r1.text()).toBe("<p>v1</p>");

		await host.storage.write("/src/components/L.astro", new TextEncoder().encode("<p>v2</p>"));

		const r2 = await server.fetch(new Request("https://app/"));
		expect(await r2.text()).toBe("<p>v2</p>");
	});
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("preview server: errors", () => {
	it("returns 500 with a useful message on compile error", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<p>oops {unclosed</p>",
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(r.status).toBe(500);
		expect(await r.text()).toMatch(/compile error/i);
	});

	it("returns 500 if the storage read fails for a matched route", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": "<p>x</p>",
		});
		// Trigger route discovery so the route is in the table.
		await server.fetch(new Request("https://app/"));
		// Now delete the underlying file. Subsequent requests match the route
		// but storage.read throws.
		await host.storage.remove("/src/pages/index.astro");
		const r = await server.fetch(new Request("https://app/"));
		expect(r.status).toBe(500);
	});
});
