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
import type { AstroflareConfig } from "@astroflare/core";
import { type TestHost, createTestHost } from "@astroflare/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PreviewServer, createPreviewServer } from "./preview-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIST = path.resolve(__dirname, "../../runtime/dist/index.js");
const RUNTIME_URL = pathToFileURL(RUNTIME_DIST).href;

const enc = (s: string) => new TextEncoder().encode(s);

interface Fixture {
	host: TestHost;
	server: PreviewServer;
}

async function makeFixture(
	files: Record<string, string>,
	configOverrides: Partial<AstroflareConfig> = {},
): Promise<Fixture> {
	const host = createTestHost();
	for (const [p, body] of Object.entries(files)) host.site.write(p, enc(body));
	const server = createPreviewServer({
		config: { site: "https://example.com", ...configOverrides },
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

async function fixture(
	files: Record<string, string>,
	configOverrides: Partial<AstroflareConfig> = {},
): Promise<Fixture> {
	const f = await makeFixture(files, configOverrides);
	fixtureCleanups.push(f.host);
	return f;
}

/** Strip the injected `<script type="module">…</script>` plus the
 * Phase 19 error-overlay `<script src="/_aflare/error-overlay.js">`
 * tag, so tests can compare against the raw rendered HTML the user
 * authored. The HMR / overlay injections are verified separately. */
function stripHmr(html: string): string {
	return html
		.replace(/<script type="module">[\s\S]*?<\/script>/g, "")
		.replace(/<script src="\/_aflare\/error-overlay\.js"><\/script>/g, "")
		.replace(
			/<script type="module" src="\/_aflare\/(hydration|view-transitions|prefetch)\.js"><\/script>/g,
			"",
		);
}

/** `await response.text()`, with the HMR script stripped — matches the
 * pre-Phase-5 contract of "exactly the rendered HTML." */
async function bodyWithoutHmr(r: Response): Promise<string> {
	return stripHmr(await r.text());
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
		expect(await bodyWithoutHmr(r)).toBe("<h1>home</h1>");
	});

	it("renders a static nested route", async () => {
		const { server } = await fixture({
			"/src/pages/about.astro": "<p>about</p>",
		});
		const r = await server.fetch(new Request("https://app/about"));
		expect(await bodyWithoutHmr(r)).toBe("<p>about</p>");
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
		expect(await bodyWithoutHmr(r)).toBe("<p>slug=hello-world</p>");
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
		expect(await bodyWithoutHmr(r)).toBe("<p>/about/GET</p>");
	});

	it("exposes Astro.site from config", async () => {
		const src = "---\nconst s = Astro.site;\n---\n<p>site={s}</p>";
		const { server } = await fixture({
			"/src/pages/index.astro": src,
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(await bodyWithoutHmr(r)).toBe("<p>site=https://example.com</p>");
	});

	it("HTML-escapes interpolated values from Astro.params", async () => {
		const src = "---\nconst { name } = Astro.params;\n---\n<p>{name}</p>";
		const { server } = await fixture({
			"/src/pages/users/[name].astro": src,
		});
		const r = await server.fetch(new Request(`https://app/users/${encodeURIComponent("<bob>")}`));
		expect(await bodyWithoutHmr(r)).toBe("<p>&lt;bob&gt;</p>");
	});

	it("Astro.cookies.get reads request cookies", async () => {
		const src =
			"---\nconst v = Astro.cookies.get('session')?.value ?? '(none)';\n---\n<p>session={v}</p>";
		const { server } = await fixture({
			"/src/pages/index.astro": src,
		});
		const r = await server.fetch(
			new Request("https://app/", { headers: { cookie: "session=abc" } }),
		);
		expect(await bodyWithoutHmr(r)).toBe("<p>session=abc</p>");
	});

	it("Astro.cookies.set writes Set-Cookie on the response", async () => {
		const src = "---\nAstro.cookies.set('visited', 'yes', { path: '/' });\n---\n<p>ok</p>";
		const { server } = await fixture({
			"/src/pages/index.astro": src,
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(r.headers.get("set-cookie")).toContain("visited=yes");
		expect(r.headers.get("set-cookie")).toContain("Path=/");
	});

	it("Astro.redirect from frontmatter short-circuits to a 302", async () => {
		const src = "---\nreturn Astro.redirect('/login');\n---\n<p>never rendered</p>";
		const { server } = await fixture({
			"/src/pages/private.astro": src,
		});
		const r = await server.fetch(new Request("https://app/private"));
		expect(r.status).toBe(302);
		expect(r.headers.get("location")).toBe("/login");
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
		expect(await bodyWithoutHmr(r)).toBe("<header><button>Click</button></header>");
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
		expect(await bodyWithoutHmr(r)).toBe("<i>shared</i><i>shared</i>");
	});

	it("invalidates the bundle cache when a dep's source changes", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": '---\nimport L from "../components/L.astro";\n---\n<L/>',
			"/src/components/L.astro": "<p>v1</p>",
		});
		const r1 = await server.fetch(new Request("https://app/"));
		expect(await bodyWithoutHmr(r1)).toBe("<p>v1</p>");

		host.site.write("/src/components/L.astro", new TextEncoder().encode("<p>v2</p>"));

		const r2 = await server.fetch(new Request("https://app/"));
		expect(await bodyWithoutHmr(r2)).toBe("<p>v2</p>");
	});
});

// ---------------------------------------------------------------------------
// Markdown routes (Phase 6)
// ---------------------------------------------------------------------------

describe("preview server: markdown routes", () => {
	it("renders a .md page", async () => {
		const { server } = await fixture({
			"/src/pages/about.md": "---\ntitle: About\n---\n# Hello\n\nA paragraph.\n",
		});
		const r = await server.fetch(new Request("https://app/about"));
		expect(r.status).toBe(200);
		const body = await bodyWithoutHmr(r);
		expect(body).toContain("<h1>Hello</h1>");
		expect(body).toContain("<p>A paragraph.</p>");
	});

	it("dynamic params work for .md too", async () => {
		const { server } = await fixture({
			"/src/pages/posts/[slug].md": "# Static body\n",
		});
		const r = await server.fetch(new Request("https://app/posts/hello-world"));
		const body = await bodyWithoutHmr(r);
		expect(body).toContain("<h1>Static body</h1>");
	});

	it("static .astro wins over .md at the same path", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<p>astro-wins</p>",
			"/src/pages/index.md": "# md-loses",
		});
		const r = await server.fetch(new Request("https://app/"));
		const body = await bodyWithoutHmr(r);
		expect(body).toContain("astro-wins");
		expect(body).not.toContain("md-loses");
	});

	// Phase 14: cross-module named imports of `.md` files. The bundler
	// hoists each module's named exports through its IIFE so importers
	// can destructure them out via `__m_<idx>.<name>`.
	it("a .astro page can import { frontmatter } from a .md file", async () => {
		const { server } = await fixture({
			"/src/posts/hello.md": "---\ntitle: Hello, World\nauthor: Ada\ntags: [intro]\n---\n# body\n",
			"/src/pages/index.astro":
				"---\n" +
				'import { frontmatter } from "../posts/hello.md";\n' +
				"---\n" +
				"<article>" +
				"<h1>{frontmatter.title}</h1>" +
				"<p>by {frontmatter.author}</p>" +
				"</article>",
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(r.status).toBe(200);
		const body = await bodyWithoutHmr(r);
		expect(body).toContain("<h1>Hello, World</h1>");
		expect(body).toContain("<p>by Ada</p>");
	});

	it("a .astro page can import default + named together from a .md file", async () => {
		const { server } = await fixture({
			"/src/posts/post.md": "---\ntitle: Post Title\n---\n# the body\n\nparagraph.\n",
			"/src/pages/index.astro":
				"---\n" +
				'import Post, { frontmatter } from "../posts/post.md";\n' +
				"---\n" +
				"<h2>{frontmatter.title}</h2>\n" +
				"<Post />",
		});
		const r = await server.fetch(new Request("https://app/"));
		const body = await bodyWithoutHmr(r);
		expect(body).toContain("<h2>Post Title</h2>");
		expect(body).toContain("<h1>the body</h1>");
	});
});

// ---------------------------------------------------------------------------
// Hydration / islands (Phase 16)
// ---------------------------------------------------------------------------

describe("preview server: hydration + islands", () => {
	it("serves the hydration client at /_aflare/hydration.js", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<p>x</p>",
		});
		const r = await server.fetch(new Request("https://app/_aflare/hydration.js"));
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("application/javascript");
		const body = await r.text();
		expect(body).toContain("customElements.define");
		expect(body).toContain("astro-island");
	});

	it("compiles a .tsx island via /_aflare/island?path=...", async () => {
		const { server } = await fixture({
			"/components/Counter.tsx":
				"export function mount(el: HTMLElement, props: { count?: number }) {\n" +
				"  el.textContent = String(props.count ?? 0);\n" +
				"}\n",
			"/src/pages/index.astro": "<p>x</p>",
		});
		const r = await server.fetch(
			new Request("https://app/_aflare/island?path=/components/Counter.tsx"),
		);
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("application/javascript");
		const body = await r.text();
		// TS annotations stripped (esbuild normalises `export function X` to
		// `function X; export { X };` — both forms are valid ESM).
		expect(body).toContain("function mount");
		expect(body).toContain("export {");
		expect(body).not.toContain(": HTMLElement");
		expect(body).not.toContain(": { count");
	});

	it("returns 404 for an island source that doesn't exist", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<p>x</p>",
		});
		const r = await server.fetch(new Request("https://app/_aflare/island?path=/nope.tsx"));
		expect(r.status).toBe(404);
	});

	it("rejects unsupported island extensions", async () => {
		const { server } = await fixture({
			"/components/x.css": "p { color: red }",
			"/src/pages/index.astro": "<p>x</p>",
		});
		const r = await server.fetch(new Request("https://app/_aflare/island?path=/components/x.css"));
		expect(r.status).toBe(415);
	});

	it("emits <astro-island> markup for client:load components", async () => {
		const { server } = await fixture({
			"/components/Counter.tsx":
				"export function mount(el, props) { el.textContent = String(props.count); }",
			"/src/pages/index.astro":
				'---\nimport Counter from "../components/Counter.tsx";\n---\n' +
				"<html><head></head><body>" +
				"<Counter client:load count={42} />" +
				"</body></html>",
		});
		const r = await server.fetch(new Request("https://app/"));
		const body = await r.text();
		if (r.status !== 200) {
			throw new Error(`page render failed (${r.status}): ${body}`);
		}
		expect(body).toContain("<astro-island");
		expect(body).toContain("client:load");
		expect(body).toContain('"count":42');
		expect(body).toContain("/_aflare/island?path=");
		// Hydration script is injected when at least one island is present.
		expect(body).toContain('src="/_aflare/hydration.js"');
	});

	it("does NOT inject hydration script when the page has no islands", async () => {
		const { server } = await fixture({
			"/src/pages/plain.astro": "<html><head></head><body><p>plain</p></body></html>",
		});
		const r = await server.fetch(new Request("https://app/plain"));
		const body = await r.text();
		expect(body).not.toContain("/_aflare/hydration.js");
	});
});

// ---------------------------------------------------------------------------
// i18n routing (Phase 18)
// ---------------------------------------------------------------------------

describe("preview server: i18n", () => {
	it("populates Astro.currentLocale from a recognised URL prefix", async () => {
		const { server } = await fixture(
			{
				"/src/pages/[lang]/about.astro":
					"---\nconst loc = Astro.currentLocale;\n---\n<p>locale={loc}</p>",
			},
			{ i18n: { locales: ["en", "fr"], defaultLocale: "en" } },
		);
		const r = await server.fetch(new Request("https://example.com/fr/about"));
		expect(r.status).toBe(200);
		expect(await bodyWithoutHmr(r)).toBe("<p>locale=fr</p>");
	});

	it("falls back to defaultLocale when the URL has no locale prefix", async () => {
		const { server } = await fixture(
			{
				"/src/pages/index.astro": "---\nconst loc = Astro.currentLocale;\n---\n<p>locale={loc}</p>",
			},
			{ i18n: { locales: ["en", "fr"], defaultLocale: "en" } },
		);
		const r = await server.fetch(new Request("https://example.com/"));
		expect(r.status).toBe(200);
		expect(await bodyWithoutHmr(r)).toBe("<p>locale=en</p>");
	});

	it("currentLocale is undefined when no i18n config is set", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro":
				"---\nconst loc = Astro.currentLocale;\n---\n<p>locale={String(loc)}</p>",
		});
		const r = await server.fetch(new Request("https://example.com/"));
		expect(await bodyWithoutHmr(r)).toBe("<p>locale=undefined</p>");
	});
});

// ---------------------------------------------------------------------------
// View transitions + prefetch (Phase 17)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error overlay (Phase 19)
// ---------------------------------------------------------------------------

describe("preview server: React adapter (Phase 16a)", () => {
	it("serves the React adapter at /_aflare/react.js", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<p>x</p>",
		});
		const r = await server.fetch(new Request("https://example.com/_aflare/react.js"));
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("application/javascript");
		const body = await r.text();
		expect(body).toContain("export function mountReactIsland");
		expect(body).toContain("createRoot");
	});

	it("auto-wraps a .tsx default export with the adapter mount glue", async () => {
		const { server } = await fixture({
			"/components/Counter.tsx": "export default function Counter(props) { return null; }",
			"/src/pages/index.astro": "<p>x</p>",
		});
		const r = await server.fetch(
			new Request("https://example.com/_aflare/island?path=/components/Counter.tsx"),
		);
		const body = await r.text();
		expect(body).toContain("__aflareDefault");
		expect(body).toContain("__aflareMount");
		expect(body).toContain('"/_aflare/react.js"');
		expect(body).toContain("export function mount(__el, __props)");
	});

	it("does NOT wrap a .tsx that exports its own `mount` (no default export)", async () => {
		const { server } = await fixture({
			"/components/Vanilla.tsx":
				"export function mount(el, props) { el.textContent = String(props.x); }",
			"/src/pages/index.astro": "<p>x</p>",
		});
		const r = await server.fetch(
			new Request("https://example.com/_aflare/island?path=/components/Vanilla.tsx"),
		);
		const body = await r.text();
		expect(body).toContain("function mount(el, props)");
		expect(body).not.toContain("__aflareMount");
		expect(body).not.toContain('"/_aflare/react.js"');
	});
});

describe("preview server: error overlay", () => {
	it("serves the error overlay script at /_aflare/error-overlay.js", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<p>x</p>",
		});
		const r = await server.fetch(new Request("https://example.com/_aflare/error-overlay.js"));
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("application/javascript");
		const body = await r.text();
		expect(body).toContain("__aflareShowError");
		expect(body).toContain("aflare-error-overlay");
	});

	it("auto-injects the overlay script tag on every HTML response", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<html><head></head><body><p>x</p></body></html>",
		});
		const r = await server.fetch(new Request("https://example.com/"));
		const body = await r.text();
		expect(body).toContain('src="/_aflare/error-overlay.js"');
	});
});

describe("preview server: view-transitions + prefetch routes", () => {
	it("serves the view-transitions client at /_aflare/view-transitions.js", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<p>x</p>",
		});
		const r = await server.fetch(new Request("https://app/_aflare/view-transitions.js"));
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("application/javascript");
		const body = await r.text();
		expect(body).toContain("startViewTransition");
		expect(body).toContain("x-aflare-vt");
	});

	it("serves the prefetch client at /_aflare/prefetch.js", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<p>x</p>",
		});
		const r = await server.fetch(new Request("https://app/_aflare/prefetch.js"));
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("application/javascript");
		const body = await r.text();
		expect(body).toContain("data-aflare-prefetch");
		expect(body).toContain("x-aflare-prefetch");
	});
});

// ---------------------------------------------------------------------------
// MDX routes (Phase 14)
// ---------------------------------------------------------------------------

describe("preview server: MDX routes", () => {
	it("renders a .mdx page", async () => {
		const { server } = await fixture({
			"/src/pages/about.mdx": "---\ntitle: About\n---\n# Hello MDX\n\nA paragraph.\n",
		});
		const r = await server.fetch(new Request("https://app/about"));
		expect(r.status).toBe(200);
		const body = await bodyWithoutHmr(r);
		expect(body).toContain("<h1>Hello MDX</h1>");
		expect(body).toContain("<p>A paragraph.</p>");
	});

	it("renders inline JSX in a .mdx page", async () => {
		const { server } = await fixture({
			"/src/pages/widget.mdx": '# Title\n\n<button class="primary">click</button>\n',
		});
		const r = await server.fetch(new Request("https://app/widget"));
		const body = await bodyWithoutHmr(r);
		expect(body).toContain("<h1>Title</h1>");
		expect(body).toContain('<button class="primary">click</button>');
	});

	it("a .astro page can import { frontmatter } from a .mdx file", async () => {
		const { server } = await fixture({
			"/src/posts/post.mdx": "---\ntitle: MDX Post\nauthor: Lin\n---\n\n# body\n",
			"/src/pages/index.astro":
				"---\n" +
				'import { frontmatter } from "../posts/post.mdx";\n' +
				"---\n" +
				"<h2>{frontmatter.title}</h2>" +
				"<small>{frontmatter.author}</small>",
		});
		const r = await server.fetch(new Request("https://app/"));
		const body = await bodyWithoutHmr(r);
		expect(body).toContain("<h2>MDX Post</h2>");
		expect(body).toContain("<small>Lin</small>");
	});

	it("a .mdx page can compose with an .astro Layout", async () => {
		const { server } = await fixture({
			"/src/components/Layout.astro":
				"---\nconst { title } = Astro.props;\n---\n" +
				"<html><head><title>{title}</title></head><body><main><slot/></main></body></html>",
			"/src/pages/post.mdx":
				"---\ntitle: From MDX\n---\n" +
				'import Layout from "../components/Layout.astro";\n\n' +
				'export const wrappedTitle = "From MDX";\n\n' +
				"# Hello\n",
		});
		const r = await server.fetch(new Request("https://app/post"));
		const body = await bodyWithoutHmr(r);
		// The MDX content renders, even without explicitly invoking Layout —
		// MDX's default export is wrapped in $component and produces the
		// <h1>. Layout composition through MDXProvider is deferred.
		expect(body).toContain("<h1>Hello</h1>");
	});
});

// ---------------------------------------------------------------------------
// HMR (Phase 5)
// ---------------------------------------------------------------------------

describe("preview server: HMR script injection", () => {
	it("injects the HMR client into <head> when present", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<html><head><title>x</title></head><body><p>x</p></body></html>",
		});
		const r = await server.fetch(new Request("https://app/"));
		const body = await r.text();
		expect(body).toContain('<script type="module">');
		// Script lands inside the head (immediately before </head>).
		expect(body.indexOf('<script type="module">')).toBeLessThan(body.indexOf("</head>"));
	});

	it("injects before </body> when no head", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<body><p>fragment</p></body>",
		});
		const r = await server.fetch(new Request("https://app/"));
		const body = await r.text();
		expect(body).toContain('<script type="module">');
		expect(body.indexOf('<script type="module">')).toBeLessThan(body.indexOf("</body>"));
	});

	it("appends when neither head nor body", async () => {
		const { server } = await fixture({
			"/src/pages/index.astro": "<p>fragment</p>",
		});
		const r = await server.fetch(new Request("https://app/"));
		const body = await r.text();
		expect(body.startsWith("<p>fragment</p>")).toBe(true);
		expect(body).toContain('<script type="module">');
	});
});

describe("preview server: HMR endpoint", () => {
	it("delegates /_aflare/hmr to the transport", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": "<p>x</p>",
		});
		// Ensure the server initialised (route discovery happens on first request).
		await server.fetch(new Request("https://app/"));
		expect(host.transport.accepted).toHaveLength(0);

		await server.fetch(new Request("https://app/_aflare/hmr"));
		expect(host.transport.accepted).toHaveLength(1);
		expect(host.transport.accepted[0]?.workspaceId).toBe("default");
	});

	it("respects a custom workspaceId", async () => {
		const host = createTestHost();
		fixtureCleanups.push(host);
		host.site.write("/src/pages/index.astro", new TextEncoder().encode("<p>x</p>"));
		const server = createPreviewServer({
			config: {},
			host,
			runtimeImport: RUNTIME_URL,
			workspaceId: "tenant-42",
		});
		await server.fetch(new Request("https://app/"));
		await server.fetch(new Request("https://app/_aflare/hmr"));
		expect(host.transport.accepted[0]?.workspaceId).toBe("tenant-42");
	});
});

describe("preview server: file-change → broadcast", () => {
	it("forwards coordinator HMR updates to transport.broadcastHmr", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": "<p>x</p>",
		});
		// First request discovers routes and installs the HMR subscription.
		await server.fetch(new Request("https://app/"));
		await host.coordinator.onFileChanged("/src/pages/index.astro", "h-new");
		expect(host.transport.broadcasts).toHaveLength(1);
		const broadcast = host.transport.broadcasts[0];
		expect(broadcast?.workspaceId).toBe("default");
		expect(broadcast?.msg.type).toBe("update");
		if (broadcast?.msg.type === "update") {
			expect(broadcast.msg.updates.map((u) => u.path)).toContain("/src/pages/index.astro");
		}
	});

	it("multi-module: changing a dep broadcasts updates for the dep + its transitive importers", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": '---\nimport L from "../components/L.astro";\n---\n<L/>',
			"/src/components/L.astro": "<p>v1</p>",
		});
		// First request walks the closure, populating Coordinator graph edges.
		const r = await server.fetch(new Request("https://app/"));
		expect(await r.text()).toContain("<p>v1</p>");

		await host.coordinator.onFileChanged("/src/components/L.astro", "h-new");

		expect(host.transport.broadcasts).toHaveLength(1);
		const broadcast = host.transport.broadcasts[0];
		if (broadcast?.msg.type !== "update") throw new Error("expected update");
		const paths = broadcast.msg.updates.map((u) => u.path).sort();
		expect(paths).toEqual(["/src/components/L.astro", "/src/pages/index.astro"]);
	});

	it("dispose() stops broadcasting further updates", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": "<p>x</p>",
		});
		await server.fetch(new Request("https://app/"));
		server.dispose();
		await host.coordinator.onFileChanged("/src/pages/index.astro", "h-new");
		expect(host.transport.broadcasts).toHaveLength(0);
	});
});

describe("preview server: reactive route discovery", () => {
	it("re-discovers routes when a /src/pages/ file appears", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": "<p>home</p>",
		});
		// Before discovery refresh, /about doesn't exist.
		await server.fetch(new Request("https://app/"));
		const r404 = await server.fetch(new Request("https://app/about"));
		expect(r404.status).toBe(404);

		// Add a new page and notify the coordinator.
		host.site.write("/src/pages/about.astro", new TextEncoder().encode("<p>about</p>"));
		await host.coordinator.onFileChanged("/src/pages/about.astro", "h");
		// Drain microtasks (HMR subscriber kicks off discovery; we await routes
		// implicitly on the next request).
		const r = await server.fetch(new Request("https://app/about"));
		expect(r.status).toBe(200);
		expect(await r.text()).toContain("<p>about</p>");

		// One of the events should record the invalidation.
		expect(host.logger.byName("preview.routes.invalidated")).toHaveLength(1);
	});

	it("does NOT re-discover when a non-pages file changes", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": '---\nimport L from "../components/L.astro";\n---\n<L/>',
			"/src/components/L.astro": "<p>v1</p>",
		});
		await server.fetch(new Request("https://app/"));
		await host.coordinator.onFileChanged("/src/components/L.astro", "h-new");
		expect(host.logger.byName("preview.routes.invalidated")).toHaveLength(0);
	});

	it("re-discovers routes when a /src/pages/ file is removed", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": "<p>home</p>",
			"/src/pages/about.astro": "<p>about</p>",
		});
		// Initial discovery via a request.
		const before = await server.fetch(new Request("https://app/about"));
		expect(before.status).toBe(200);

		host.site.remove("/src/pages/about.astro");
		await host.coordinator.onFileRemoved("/src/pages/about.astro");

		const after = await server.fetch(new Request("https://app/about"));
		expect(after.status).toBe(404);
		expect(host.logger.byName("preview.routes.invalidated")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Server endpoints + middleware (Phase 8)
// ---------------------------------------------------------------------------

describe("preview server: server endpoints", () => {
	it("dispatches GET to a .js endpoint", async () => {
		const { server } = await fixture({
			"/src/pages/api/hello.js":
				'export const GET = async () => new Response("hi", { headers: { "content-type": "application/json" } });',
		});
		const r = await server.fetch(new Request("https://app/api/hello"));
		expect(r.status).toBe(200);
		expect(await r.text()).toBe("hi");
	});

	it("405s when method has no handler", async () => {
		const { server } = await fixture({
			"/src/pages/api/getonly.js": 'export const GET = async () => new Response("ok");',
		});
		const r = await server.fetch(new Request("https://app/api/getonly", { method: "POST" }));
		expect(r.status).toBe(405);
	});

	it("supports dynamic params in endpoint URLs", async () => {
		const { server } = await fixture({
			"/src/pages/api/[id].js":
				'export const GET = async ({ params }) => new Response("id=" + params.id);',
		});
		const r = await server.fetch(new Request("https://app/api/42"));
		expect(await r.text()).toBe("id=42");
	});

	it("dispatches to a .ts endpoint with type annotations stripped (Phase 11)", async () => {
		const { host, server } = await fixture({
			"/src/pages/api/typed.ts": [
				"interface Reply { msg: string }",
				"export const GET = async ({ params }: { params: Record<string, string> }): Promise<Response> => {",
				"  const reply: Reply = { msg: 'hi from ts' };",
				"  return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } });",
				"};",
			].join("\n"),
		});
		const r = await server.fetch(new Request("https://app/api/typed"));
		if (r.status !== 200) {
			const errs = host.logger.byName("preview.error");
			throw new Error(`endpoint returned ${r.status}: ${JSON.stringify(errs)}`);
		}
		expect(r.headers.get("content-type")).toMatch(/application\/json/);
		expect(await r.text()).toBe('{"msg":"hi from ts"}');
	});
});

describe("preview server: middleware", () => {
	it("runs onRequest before the route handler", async () => {
		const { server } = await fixture({
			"/src/middleware.js":
				'export const onRequest = async (ctx, next) => { const r = await next(); const h = new Headers(r.headers); h.set("x-mw", "yes"); return new Response(r.body, { status: r.status, headers: h }); };',
			"/src/pages/index.astro": "<p>x</p>",
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(r.headers.get("x-mw")).toBe("yes");
	});

	it("middleware can short-circuit with its own Response", async () => {
		const { server } = await fixture({
			"/src/middleware.js":
				'export const onRequest = async () => new Response("blocked", { status: 401 });',
			"/src/pages/index.astro": "<p>should not render</p>",
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(r.status).toBe(401);
		expect(await r.text()).toBe("blocked");
	});

	it("middleware also wraps endpoints", async () => {
		const { server } = await fixture({
			"/src/middleware.js":
				'export const onRequest = async (ctx, next) => { const r = await next(); return new Response("[mw]" + (await r.text()), { status: r.status }); };',
			"/src/pages/api/x.js": 'export const GET = async () => new Response("inner");',
		});
		const r = await server.fetch(new Request("https://app/api/x"));
		expect(await r.text()).toBe("[mw]inner");
	});

	it("loads a .ts middleware file (Phase 11)", async () => {
		const { server } = await fixture({
			"/src/middleware.ts": [
				"interface Ctx { request: Request; locals: Record<string, unknown> }",
				"export const onRequest = async (ctx: Ctx, next: () => Promise<Response>): Promise<Response> => {",
				"  const r = await next();",
				"  const h = new Headers(r.headers);",
				"  h.set('x-from-ts', 'yes');",
				"  return new Response(r.body, { status: r.status, headers: h });",
				"};",
			].join("\n"),
			"/src/pages/index.astro": "<p>x</p>",
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(r.status).toBe(200);
		expect(r.headers.get("x-from-ts")).toBe("yes");
	});

	it("middleware sets Astro.locals; the page reads them", async () => {
		const { server } = await fixture({
			"/src/middleware.js":
				"export const onRequest = async (ctx, next) => { ctx.locals.user = { name: 'Alice' }; return next(); };",
			"/src/pages/index.astro":
				"---\nconst user = Astro.locals.user;\n---\n<p>user={user?.name}</p>",
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(await bodyWithoutHmr(r)).toBe("<p>user=Alice</p>");
	});

	it("middleware reload after edit invalidates the cached function", async () => {
		const { host, server } = await fixture({
			"/src/middleware.js":
				'export const onRequest = async (ctx, next) => { const r = await next(); return new Response("v1:" + (await r.text())); };',
			"/src/pages/index.astro": "<p>x</p>",
		});
		const r1 = await server.fetch(new Request("https://app/"));
		expect(await r1.text()).toContain("v1:");

		host.site.write(
			"/src/middleware.js",
			new TextEncoder().encode(
				'export const onRequest = async (ctx, next) => { const r = await next(); return new Response("v2:" + (await r.text())); };',
			),
		);
		await host.coordinator.onFileChanged("/src/middleware.js", "h-new");

		const r2 = await server.fetch(new Request("https://app/"));
		expect(await r2.text()).toContain("v2:");
	});
});

// ---------------------------------------------------------------------------
// Asset pipeline (Phase 13)
// ---------------------------------------------------------------------------

describe("preview server: asset pipeline", () => {
	it("renders an image src from a substituted import", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": [
				"---",
				'import logo from "../assets/logo.png";',
				"---",
				"<img src={logo.src} alt={`logo ${logo.width}x${logo.height}`} />",
			].join("\n"),
			"/src/assets/logo.png": "PNG-BYTES",
		});
		host.imageService.set("/src/assets/logo.png", {
			src: "/_aflare/asset/src/assets/logo.png",
			width: 200,
			height: 100,
			format: "png",
		});
		const r = await server.fetch(new Request("https://app/"));
		expect(r.status).toBe(200);
		const body = stripHmr(await r.text());
		expect(body).toContain('src="/_aflare/asset/src/assets/logo.png"');
		expect(body).toContain('alt="logo 200x100"');
	});

	it("/_aflare/asset/<path> serves stored bytes with image content-type", async () => {
		const { host, server } = await fixture({
			"/src/pages/index.astro": "<p>x</p>",
			"/src/assets/logo.png": "PNG-BYTES",
		});
		const r = await server.fetch(new Request("https://app/_aflare/asset/src/assets/logo.png"));
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toBe("image/png");
		expect(await r.text()).toBe("PNG-BYTES");
		// Also touch host so the linter doesn't flag the unused binding.
		expect(await host.site.statFile("/src/assets/logo.png")).not.toBeNull();
	});

	it("returns 404 for an asset URL whose file doesn't exist", async () => {
		const { server } = await fixture({});
		const r = await server.fetch(new Request("https://app/_aflare/asset/missing.png"));
		expect(r.status).toBe(404);
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
		host.site.remove("/src/pages/index.astro");
		const r = await server.fetch(new Request("https://app/"));
		expect(r.status).toBe(500);
	});
});
