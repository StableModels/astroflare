/**
 * Workers-runtime `buildSite` tests.
 *
 * Uses `MemorySite` + `InProcessExecutor` from `@astroflare/test-utils`
 * — the same in-memory substrate that backs Layer A framework tests.
 * No `node:fs` / `node:os` etc. inside `build-site-workers` itself; the
 * test merely uses Node-specific helpers to spin up the executor.
 *
 * Round-trip coverage:
 *   - the iterable yields one entry per `.astro` page, in stable order
 *   - each entry has the expected `route`, `contentType`, byte length,
 *     and a stable hex hash
 *   - `prefix` mounts pages under a sub-path, mirroring the Node version
 *   - dynamic `[slug].astro` routes enumerate via `getStaticPaths` —
 *     one entry per declared params/props pair, props threaded into the
 *     render, errors and missing exports surfaced with the source path
 *   - missing pages glob → no entries (graceful empty-site case)
 */
import type { BuildSiteOutput, SnapshotEntry, SnapshotError } from "@astroflare/core";
import { sha256Hex } from "@astroflare/core";
import { InProcessExecutor, MemorySite } from "@astroflare/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { buildSite } from "./build-site-workers.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const RUNTIME_MODULES = loadRuntimeModules();

function loadRuntimeModules(): Record<string, string> {
	// Test-time only: use Node fs to read the runtime dist so the
	// executor's spawned isolate can resolve `./runtime/index.js`.
	// build-site-workers itself never touches the filesystem.
	const fs = require("node:fs") as typeof import("node:fs");
	const path = require("node:path") as typeof import("node:path");
	const url = require("node:url") as typeof import("node:url");
	const here = path.dirname(url.fileURLToPath(import.meta.url));
	const dist = path.resolve(here, "../../runtime/dist");
	const out: Record<string, string> = {};
	if (!fs.existsSync(dist)) {
		throw new Error(
			`build-site-workers tests need @astroflare/runtime built (${dist} missing) — run \`pnpm -w build\``,
		);
	}
	for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
		const src = fs.readFileSync(path.join(dist, entry.name), "utf8");
		out[`runtime/${entry.name}`] = src;
	}
	if (!("runtime/index.js" in out)) {
		throw new Error("runtime/index.js missing from runtime dist");
	}
	return out;
}

const executors: InProcessExecutor[] = [];
afterEach(async () => {
	await Promise.all(executors.splice(0).map((e) => e.dispose()));
});

function makeExecutor(): InProcessExecutor {
	const base = new InProcessExecutor();
	executors.push(base);
	// Wrap so every TaskBundle gets the runtime modules merged in,
	// mirroring how `createWorkerdExecutor({ runtime })` behaves in
	// production.
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop === "runOnce") {
				return (task: import("@astroflare/core").TaskBundle, input: unknown) => {
					return target.runOnce(merge(task), input);
				};
			}
			if (prop === "runCached") {
				return (
					id: string,
					factory: () => import("@astroflare/core").TaskBundle,
					input: unknown,
				) => {
					return target.runCached(id, () => merge(factory()), input);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as InProcessExecutor;
}

function merge(task: import("@astroflare/core").TaskBundle): import("@astroflare/core").TaskBundle {
	return {
		...task,
		modules: { ...RUNTIME_MODULES, ...task.modules },
	};
}

describe("buildSite (workers-runtime)", () => {
	it("yields one entry per page in sorted route order", async () => {
		const site = new MemorySite();
		site.write("/src/pages/index.astro", enc("---\n---\n<h1>home</h1>"));
		site.write("/src/pages/about.astro", enc("---\n---\n<h1>about</h1>"));
		site.write("/src/pages/blog/index.astro", enc("---\n---\n<h1>blog</h1>"));

		const executor = makeExecutor();
		const entries: import("@astroflare/core").SnapshotEntry[] = [];
		for await (const entry of buildSite({ site, executor })) {
			entries.push(entry);
		}

		const routes = entries.map((e) => e.route);
		// Glob iteration is alphabetical by source path:
		// /src/pages/about.astro → /about
		// /src/pages/blog/index.astro → /blog
		// /src/pages/index.astro → /
		expect(routes).toEqual(["/about", "/blog", "/"]);
		for (const e of entries) {
			expect(e.contentType).toBe("text/html;charset=utf-8");
			expect(e.bytes.byteLength).toBeGreaterThan(0);
			expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
			// Hash is stable: SHA-256(bytes).
			const expected = await sha256Hex(e.bytes);
			expect(e.hash).toBe(expected);
		}
	});

	it("renders the HTML body and surfaces frontmatter expressions", async () => {
		const site = new MemorySite();
		site.write(
			"/src/pages/index.astro",
			enc('---\nconst greeting = "hello world";\n---\n<h1>{greeting}</h1>'),
		);

		const executor = makeExecutor();
		const entries: import("@astroflare/core").SnapshotEntry[] = [];
		for await (const entry of buildSite({ site, executor })) {
			entries.push(entry);
		}
		expect(entries).toHaveLength(1);
		const first = entries[0];
		if (!first) throw new Error("expected one entry");
		const html = dec(first.bytes);
		expect(html).toContain("hello world");
	});

	it("respects prefix for sub-path mounting", async () => {
		const site = new MemorySite();
		site.write("/src/pages/index.astro", enc("---\n---\n<h1>home</h1>"));
		site.write("/src/pages/about.astro", enc("---\n---\n<h1>about</h1>"));

		const executor = makeExecutor();
		const routes: string[] = [];
		for await (const entry of buildSite({ site, executor, prefix: "tenant-a" })) {
			routes.push(entry.route);
		}
		expect(routes.sort()).toEqual(["/tenant-a/", "/tenant-a/about"]);
	});

	it("enumerates a dynamic [slug] route via getStaticPaths and renders each entry", async () => {
		const site = new MemorySite();
		site.write(
			"/src/pages/posts/[slug].astro",
			enc(`---
export async function getStaticPaths() {
	return [
		{ params: { slug: "hello-world" }, props: { title: "Hello, World" } },
		{ params: { slug: "second-post" }, props: { title: "Second post" } },
	];
}
const { slug } = Astro.params;
const { title } = Astro.props;
---
<h1>{title}</h1>
<p>slug: {slug}</p>`),
		);

		const executor = makeExecutor();
		const entries = await collect(buildSite({ site, executor }));
		const byRoute = new Map(entries.map((e) => [e.route, e]));
		expect([...byRoute.keys()].sort()).toEqual(["/posts/hello-world", "/posts/second-post"]);

		const first = byRoute.get("/posts/hello-world");
		const second = byRoute.get("/posts/second-post");
		if (!first || !second) throw new Error("expected both slugs");

		const firstHtml = dec(first.bytes);
		expect(firstHtml).toContain("Hello, World");
		expect(firstHtml).toContain("hello-world");

		const secondHtml = dec(second.bytes);
		expect(secondHtml).toContain("Second post");
		expect(secondHtml).toContain("second-post");

		// Distinct props → distinct content → distinct hashes.
		expect(first.hash).not.toBe(second.hash);
		expect(first.hash).toBe(await sha256Hex(first.bytes));
	});

	it("interleaves static and dynamic routes in deterministic source order", async () => {
		const site = new MemorySite();
		site.write("/src/pages/index.astro", enc("---\n---\n<h1>home</h1>"));
		site.write("/src/pages/about.md", enc("# about\n"));
		site.write(
			"/src/pages/posts/[slug].astro",
			enc(`---
export async function getStaticPaths() {
	return [
		{ params: { slug: "hello-world" }, props: { title: "Hello" } },
		{ params: { slug: "second-post" }, props: { title: "Second" } },
	];
}
const { title } = Astro.props;
---
<h1>{title}</h1>`),
		);

		const executor = makeExecutor();
		const routes = (await collect(buildSite({ site, executor }))).map((e) => e.route);
		// Pages glob is alphabetical by source path:
		//   /src/pages/about.md            → /about
		//   /src/pages/index.astro         → /
		//   /src/pages/posts/[slug].astro  → /posts/<slug> × 2
		expect(routes).toEqual(["/about", "/", "/posts/hello-world", "/posts/second-post"]);
	});

	it("yields no entries for a dynamic route whose getStaticPaths returns []", async () => {
		const site = new MemorySite();
		site.write(
			"/src/pages/posts/[slug].astro",
			enc(`---
export async function getStaticPaths() { return []; }
---
<h1>unused</h1>`),
		);
		const executor = makeExecutor();
		const entries = await collect(buildSite({ site, executor }));
		expect(entries).toEqual([]);
	});

	it("surfaces a getStaticPaths exception with the source path", async () => {
		const site = new MemorySite();
		site.write(
			"/src/pages/posts/[slug].astro",
			enc(`---
export async function getStaticPaths() { throw new Error("boom"); }
---
<h1>unused</h1>`),
		);
		const executor = makeExecutor();
		await expect(collect(buildSite({ site, executor }))).rejects.toThrow(
			/getStaticPaths failed for \/src\/pages\/posts\/\[slug\]\.astro.*boom/,
		);
	});

	it("throws when a dynamic route has no getStaticPaths export", async () => {
		const site = new MemorySite();
		site.write("/src/pages/posts/[slug].astro", enc("---\n---\n<h1>post</h1>"));
		const executor = makeExecutor();
		await expect(collect(buildSite({ site, executor }))).rejects.toThrow(
			/dynamic route \/src\/pages\/posts\/\[slug\]\.astro has no getStaticPaths export/,
		);
	});

	it("dynamic routes hash deterministically across runs", async () => {
		const src = enc(`---
export async function getStaticPaths() {
	return [{ params: { slug: "stable" }, props: { title: "Stable" } }];
}
const { title } = Astro.props;
---
<p>{title}</p>`);
		const site1 = new MemorySite();
		const site2 = new MemorySite();
		site1.write("/src/pages/posts/[slug].astro", src);
		site2.write("/src/pages/posts/[slug].astro", src);

		const exe1 = makeExecutor();
		const exe2 = makeExecutor();

		const e1 = (await collect(buildSite({ site: site1, executor: exe1 })))[0];
		const e2 = (await collect(buildSite({ site: site2, executor: exe2 })))[0];

		expect(e1?.route).toBe("/posts/stable");
		expect(e1?.hash).toBe(e2?.hash);
	});

	it("yields no entries when the pages glob is empty", async () => {
		const site = new MemorySite();
		const executor = makeExecutor();
		const entries: unknown[] = [];
		for await (const entry of buildSite({ site, executor })) {
			entries.push(entry);
		}
		expect(entries).toEqual([]);
	});

	it("emits one entry per /public/* file with extension-derived content-type", async () => {
		const site = new MemorySite();
		site.write("/src/pages/index.astro", enc("---\n---\n<h1>home</h1>"));
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		site.write("/public/logo.png", png);
		site.write("/public/css/site.css", enc("body{}"));

		const executor = makeExecutor();
		const entries: SnapshotEntry[] = [];
		for await (const entry of buildSite({ site, executor })) {
			entries.push(entry);
		}

		// Page first (in glob order), then public assets sorted by source path.
		const byRoute = new Map(entries.map((e) => [e.route, e]));
		expect([...byRoute.keys()].sort()).toEqual(["/", "/css/site.css", "/logo.png"]);

		const logo = byRoute.get("/logo.png");
		expect(logo?.contentType).toBe("image/png");
		expect(Array.from(logo?.bytes ?? [])).toEqual(Array.from(png));
		expect(logo?.hash).toBe(await sha256Hex(png));

		const css = byRoute.get("/css/site.css");
		expect(css?.contentType).toBe("text/css;charset=utf-8");
		expect(dec(css?.bytes ?? new Uint8Array())).toBe("body{}");
	});

	it("publicAssets: false skips /public/* enumeration", async () => {
		const site = new MemorySite();
		site.write("/src/pages/index.astro", enc("---\n---\n<h1>home</h1>"));
		site.write("/public/logo.png", new Uint8Array([1, 2, 3]));

		const executor = makeExecutor();
		const entries: SnapshotEntry[] = [];
		for await (const entry of buildSite({ site, executor, publicAssets: false })) {
			entries.push(entry);
		}
		expect(entries.map((e) => e.route)).toEqual(["/"]);
	});

	it("public-asset prefix mirrors the page prefix option", async () => {
		const site = new MemorySite();
		site.write("/src/pages/index.astro", enc("---\n---\n<h1>home</h1>"));
		site.write("/public/logo.png", new Uint8Array([1, 2, 3]));

		const executor = makeExecutor();
		const entries: SnapshotEntry[] = [];
		for await (const entry of buildSite({ site, executor, prefix: "minimal" })) {
			entries.push(entry);
		}
		const routes = entries.map((e) => e.route);
		expect(routes).toContain("/minimal/");
		expect(routes).toContain("/minimal/logo.png");
	});

	it("hashes are deterministic for the same source", async () => {
		const site1 = new MemorySite();
		const site2 = new MemorySite();
		const src = enc('---\nconst x = "stable";\n---\n<p>{x}</p>');
		site1.write("/src/pages/index.astro", src);
		site2.write("/src/pages/index.astro", src);

		const exe1 = makeExecutor();
		const exe2 = makeExecutor();

		const e1 = (await collect(buildSite({ site: site1, executor: exe1 })))[0];
		const e2 = (await collect(buildSite({ site: site2, executor: exe2 })))[0];

		expect(e1?.hash).toBe(e2?.hash);
	});

	// Regression coverage for the sucrase swap: the workers-runtime
	// `buildSite` path runs the same `compileAstro` → `transformTS`
	// pipeline as `createPreviewHandler`, so any TS-bearing
	// frontmatter that would have crashed in V8 with `Unexpected
	// strict mode reserved word` under the old esbuild-wasm path now
	// renders cleanly through the snapshot publish path too.
	it("strips TypeScript syntax in frontmatter so the spawned isolate parses the route", async () => {
		const site = new MemorySite();
		site.write(
			"/src/pages/index.astro",
			enc(
				[
					"---",
					"interface Props { title: string }",
					"type Greeting = string;",
					'const t: Greeting = "hello";',
					"---",
					"<h1>{t}</h1>",
				].join("\n"),
			),
		);

		const executor = makeExecutor();
		const entries = await collect(buildSite({ site, executor }));
		expect(entries).toHaveLength(1);
		const html = dec(entries[0]?.bytes ?? new Uint8Array());
		expect(html).toContain("<h1>hello</h1>");
	});
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of iter) out.push(x);
	return out;
}

describe("buildSite (workers-runtime) — continueOnError", () => {
	it("yields a SnapshotError for a compile failure and keeps iterating", async () => {
		const site = new MemorySite();
		site.write("/src/pages/good.astro", enc("---\n---\n<h1>good</h1>"));
		// `<p>{unclosed` is the same shape `module-graph.test.ts` uses to
		// force a parser error — the brace-finder fails to match a
		// closing `}` and the closure compile rejects.
		site.write("/src/pages/bad-compile.astro", enc("<p>{unclosed"));

		const executor = makeExecutor();
		const out = await collect(buildSite({ site, executor, continueOnError: true }));

		const entries = out.filter((x): x is SnapshotEntry => "bytes" in x);
		const errors = out.filter(
			(x): x is SnapshotError => "kind" in x && (x as SnapshotError).kind === "error",
		);

		expect(entries.map((e) => e.route).sort()).toEqual(["/good"]);
		expect(errors).toHaveLength(1);
		const err = errors[0];
		if (!err) throw new Error("expected one error");
		expect(err.sourcePath).toBe("/src/pages/bad-compile.astro");
		expect(err.phase).toBe("compile");
		expect(err.route).toBeUndefined();
		expect(err.message).toMatch(/compile failed for \/src\/pages\/bad-compile\.astro/);
		expect(err.cause).toBeInstanceOf(Error);
	});

	it("yields a SnapshotError when getStaticPaths throws and skips the dynamic route", async () => {
		const site = new MemorySite();
		site.write("/src/pages/good.astro", enc("---\n---\n<h1>good</h1>"));
		site.write(
			"/src/pages/bad-paths/[slug].astro",
			enc(`---
export async function getStaticPaths() { throw new Error("boom"); }
---
<h1>unused</h1>`),
		);

		const executor = makeExecutor();
		const out = await collect(buildSite({ site, executor, continueOnError: true }));

		const entries = out.filter((x): x is SnapshotEntry => "bytes" in x);
		const errors = out.filter(
			(x): x is SnapshotError => "kind" in x && (x as SnapshotError).kind === "error",
		);

		expect(entries.map((e) => e.route).sort()).toEqual(["/good"]);
		expect(errors).toHaveLength(1);
		const err = errors[0];
		if (!err) throw new Error("expected one error");
		expect(err.sourcePath).toBe("/src/pages/bad-paths/[slug].astro");
		expect(err.phase).toBe("getStaticPaths");
		expect(err.message).toMatch(/getStaticPaths failed.*boom/);
	});

	it("yields a SnapshotError when a dynamic route is missing getStaticPaths", async () => {
		const site = new MemorySite();
		site.write("/src/pages/posts/[slug].astro", enc("---\n---\n<h1>post</h1>"));

		const executor = makeExecutor();
		const out = await collect(buildSite({ site, executor, continueOnError: true }));

		expect(out).toHaveLength(1);
		const err = out[0] as SnapshotError;
		expect(err.kind).toBe("error");
		expect(err.sourcePath).toBe("/src/pages/posts/[slug].astro");
		expect(err.phase).toBe("getStaticPaths");
		expect(err.message).toMatch(/has no getStaticPaths export/);
		// No `cause` for the missing-export case — it's a framework-emitted error.
		expect(err.cause).toBeUndefined();
	});

	it("emits per-entry render errors for dynamic routes and keeps emitting siblings", async () => {
		const site = new MemorySite();
		// Three entries; the middle one's render references an undefined
		// identifier so its render fails. The other two should still
		// produce SnapshotEntries.
		site.write(
			"/src/pages/bad-render/[slug].astro",
			enc(`---
export async function getStaticPaths() {
	return [
		{ params: { slug: "one" }, props: { mode: "ok" } },
		{ params: { slug: "two" }, props: { mode: "boom" } },
		{ params: { slug: "three" }, props: { mode: "ok" } },
	];
}
const { mode } = Astro.props;
const { slug } = Astro.params;
if (mode === "boom") {
	throw new Error("render boom for " + slug);
}
---
<h1>{slug}</h1>`),
		);

		const executor = makeExecutor();
		const out: BuildSiteOutput[] = await collect(
			buildSite({ site, executor, continueOnError: true }),
		);

		const entries = out.filter((x): x is SnapshotEntry => "bytes" in x);
		const errors = out.filter(
			(x): x is SnapshotError => "kind" in x && (x as SnapshotError).kind === "error",
		);

		expect(entries.map((e) => e.route).sort()).toEqual(["/bad-render/one", "/bad-render/three"]);
		expect(errors).toHaveLength(1);
		const err = errors[0];
		if (!err) throw new Error("expected one render error");
		expect(err.sourcePath).toBe("/src/pages/bad-render/[slug].astro");
		expect(err.phase).toBe("render");
		expect(err.route).toBe("/bad-render/two");
		expect(err.params).toEqual({ slug: "two" });
		expect(err.message).toMatch(/render failed.*render boom for two/);
	});

	it("collects every category of failure in one pass", async () => {
		const site = new MemorySite();
		site.write("/src/pages/good.astro", enc("---\n---\n<h1>good</h1>"));
		site.write("/src/pages/bad-compile.astro", enc("<p>{unclosed"));
		site.write(
			"/src/pages/bad-paths/[slug].astro",
			enc(`---
export async function getStaticPaths() { throw new Error("paths boom"); }
---
<h1>unused</h1>`),
		);
		site.write(
			"/src/pages/bad-render/[slug].astro",
			enc(`---
export async function getStaticPaths() {
	return [
		{ params: { slug: "ok-1" }, props: { mode: "ok" } },
		{ params: { slug: "boom" }, props: { mode: "boom" } },
		{ params: { slug: "ok-2" }, props: { mode: "ok" } },
	];
}
const { mode } = Astro.props;
const { slug } = Astro.params;
if (mode === "boom") throw new Error("render boom");
---
<p>{slug}</p>`),
		);

		const executor = makeExecutor();
		const out = await collect(buildSite({ site, executor, continueOnError: true }));

		const entries = out.filter((x): x is SnapshotEntry => "bytes" in x);
		const errors = out.filter(
			(x): x is SnapshotError => "kind" in x && (x as SnapshotError).kind === "error",
		);

		expect(entries.map((e) => e.route).sort()).toEqual([
			"/bad-render/ok-1",
			"/bad-render/ok-2",
			"/good",
		]);
		expect(errors).toHaveLength(3);

		const phases = errors.map((e) => e.phase).sort();
		expect(phases).toEqual(["compile", "getStaticPaths", "render"]);

		const compileErr = errors.find((e) => e.phase === "compile");
		expect(compileErr?.sourcePath).toBe("/src/pages/bad-compile.astro");
		const pathsErr = errors.find((e) => e.phase === "getStaticPaths");
		expect(pathsErr?.sourcePath).toBe("/src/pages/bad-paths/[slug].astro");
		const renderErr = errors.find((e) => e.phase === "render");
		expect(renderErr?.sourcePath).toBe("/src/pages/bad-render/[slug].astro");
		expect(renderErr?.params?.slug).toBe("boom");
	});

	it("throws on first error when continueOnError is unset (default)", async () => {
		const site = new MemorySite();
		site.write("/src/pages/good.astro", enc("---\n---\n<h1>good</h1>"));
		site.write("/src/pages/bad-compile.astro", enc("<p>{unclosed"));

		const executor = makeExecutor();
		await expect(collect(buildSite({ site, executor }))).rejects.toThrow(
			/compile failed for \/src\/pages\/bad-compile\.astro/,
		);
	});

	it("populates structured location/snippet/codeFrame/diagnostics for compile failures", async () => {
		const site = new MemorySite();
		// Same fixture as the Node version's structured-error test — see
		// build-site.test.ts for the line/column/offset reasoning.
		site.write("/src/pages/bad-compile.astro", enc(["---", "---", "<h1>{unclosed"].join("\n")));
		const executor = makeExecutor();
		const out = await collect(buildSite({ site, executor, continueOnError: true }));
		const errors = out.filter(
			(x): x is SnapshotError => "kind" in x && (x as SnapshotError).kind === "error",
		);
		expect(errors).toHaveLength(1);
		const err = errors[0];
		if (!err) throw new Error("expected one error");

		expect(err.location).toBeDefined();
		expect(err.location?.line).toBe(3);
		expect(err.location?.column).toBe(5);
		expect(err.location?.offset).toBe(12);

		expect(err.detail).toMatch(/Unclosed expression/i);
		expect(err.codeFrame).toBeDefined();
		expect(err.codeFrame?.highlightLine).toBe(3);
		expect(err.codeFrame?.text).toContain("<h1>{unclosed");
		expect(err.codeFrame?.text).toMatch(/\^/);
		expect(err.diagnostics).toBeDefined();
		expect((err.diagnostics ?? []).length).toBeGreaterThanOrEqual(1);
		expect(err.diagnostics?.[0].location.line).toBe(3);
	});

	it("forwards the underlying stack on render failures so consumers can trace user code", async () => {
		const site = new MemorySite();
		site.write(
			"/src/pages/bad-render/[slug].astro",
			enc(`---
export async function getStaticPaths() {
	return [{ params: { slug: "boom" }, props: {} }];
}
throw new Error("render boom for " + Astro.params.slug);
---
<h1>unused</h1>`),
		);
		const executor = makeExecutor();
		const out = await collect(buildSite({ site, executor, continueOnError: true }));
		const err = out.find(
			(x): x is SnapshotError => "kind" in x && (x as SnapshotError).kind === "error",
		);
		if (!err) throw new Error("expected a render error");
		expect(err.phase).toBe("render");
		expect(err.detail).toMatch(/render boom/);
		expect(err.stack).toBeDefined();
		expect(err.stack).toContain("render boom");
	});

	it("forwards the underlying stack on getStaticPaths failures", async () => {
		const site = new MemorySite();
		site.write(
			"/src/pages/bad-paths/[slug].astro",
			enc(`---
export async function getStaticPaths() { throw new Error("paths boom"); }
---
<h1>unused</h1>`),
		);
		const executor = makeExecutor();
		const out = await collect(buildSite({ site, executor, continueOnError: true }));
		const err = out.find(
			(x): x is SnapshotError => "kind" in x && (x as SnapshotError).kind === "error",
		);
		if (!err) throw new Error("expected a getStaticPaths error");
		expect(err.phase).toBe("getStaticPaths");
		expect(err.detail).toMatch(/paths boom/);
		expect(err.stack).toBeDefined();
		expect(err.stack).toContain("paths boom");
	});
});

/**
 * Host-driven content collections, end-to-end through the real
 * `buildSite` pipeline (createContentRuntimeModule → inlineBundle's
 * `astro:content` rewrite → buildClosureRenderTask's `content.js`
 * injection → execKey digest fold). Runs on the in-process executor —
 * the same Node substrate as the rest of this file, so it adds zero
 * Worker Loader / workerd-pool isolates. (The workerd runtime exercises
 * the identical bundler/executor seam; a separate Layer-B file is
 * deliberately avoided — see PR #19 discussion: the combined
 * `singleWorker` pool trips a workerd teardown assertion when any
 * additional isolate-spawning Layer-B file is added.)
 *
 * `createPreviewHandler` (Mode A) shares this exact machinery — same
 * `createContentRuntimeModule`, same `inlineBundle(..., "./content.js")`,
 * same `buildClosureRenderTask({ contentModuleSource })`, same execKey
 * fold — so proving it here proves both modes' content path.
 */
describe("buildSite (workers-runtime) — host-driven content collections", () => {
	const SLUG_ROUTE = `---
import { getCollection } from 'astro:content';
export async function getStaticPaths() {
	const posts = await getCollection('blog');
	return posts.map((p) => ({ params: { slug: p.slug }, props: { post: p } }));
}
const { post } = Astro.props;
---
<h1>{post.data.title}</h1>
<article>{post.body}</article>`;

	const LIST_PAGE = `---
import { getCollection } from 'astro:content';
const posts = await getCollection('blog');
---
<ul>{posts.map((p) => (<li>{p.data.title}</li>))}</ul>`;

	function seedSite(): MemorySite {
		const site = new MemorySite();
		site.write("/src/pages/blog/[slug].astro", enc(SLUG_ROUTE));
		site.write("/src/pages/blog/index.astro", enc(LIST_PAGE));
		site.write(
			"/src/content/blog/hello-world.md",
			enc("---\ntitle: Hello, World\n---\nthe hello body\n"),
		);
		site.write(
			"/src/content/blog/second-post.md",
			enc("---\ntitle: A Second Post\n---\nthe second body\n"),
		);
		return site;
	}

	it("enumerates a [slug] route via getStaticPaths(getCollection) and renders frontmatter getCollection", async () => {
		const executor = makeExecutor();
		const produced = (await collect(buildSite({ site: seedSite(), executor }))).filter(
			(x): x is SnapshotEntry => "bytes" in x,
		);

		const byRoute = new Map(produced.map((e) => [e.route, new TextDecoder().decode(e.bytes)]));
		expect([...byRoute.keys()].sort()).toEqual(["/blog", "/blog/hello-world", "/blog/second-post"]);
		// getStaticPaths(getCollection('blog')) → one page per entry,
		// `post` prop threaded into the render.
		expect(byRoute.get("/blog/hello-world")).toContain("Hello, World");
		expect(byRoute.get("/blog/hello-world")).toContain("the hello body");
		expect(byRoute.get("/blog/second-post")).toContain("A Second Post");
		// list page used getCollection in frontmatter.
		expect(byRoute.get("/blog")).toContain("Hello, World");
		expect(byRoute.get("/blog")).toContain("A Second Post");
	});

	it("folds the content digest into the execution cache key — a new /src/content file busts the cache", async () => {
		// One executor across two builds. `runCached` is keyed by
		// execKey (closure bundleKey + content digest). The route
		// `.astro` source is byte-identical between runs, so without
		// the digest fold the second build would reuse the stale
		// cached isolate and never see `third-post`. Seeing it proves
		// the digest is recomputed and folded.
		const executor = makeExecutor();
		const site = seedSite();

		const first = (await collect(buildSite({ site, executor }))).filter(
			(x): x is SnapshotEntry => "bytes" in x,
		);
		expect(first.map((e) => e.route).sort()).toEqual([
			"/blog",
			"/blog/hello-world",
			"/blog/second-post",
		]);

		site.write("/src/content/blog/third-post.md", enc("---\ntitle: The Third\n---\nthird body\n"));

		const second = (await collect(buildSite({ site, executor }))).filter(
			(x): x is SnapshotEntry => "bytes" in x,
		);
		const byRoute = new Map(second.map((e) => [e.route, new TextDecoder().decode(e.bytes)]));
		expect([...byRoute.keys()].sort()).toEqual([
			"/blog",
			"/blog/hello-world",
			"/blog/second-post",
			"/blog/third-post",
		]);
		expect(byRoute.get("/blog/third-post")).toContain("The Third");
		expect(byRoute.get("/blog/third-post")).toContain("third body");
		// The list page (same source bytes) re-baked with the new entry.
		expect(byRoute.get("/blog")).toContain("The Third");
	});

	it("renders entry.rendered.html (set:html) end-to-end through buildSite, Shiki on a fence", async () => {
		const RENDERED_ROUTE = `---
import { getCollection } from 'astro:content';
export async function getStaticPaths() {
	const posts = await getCollection('blog');
	return posts.map((p) => ({ params: { slug: p.slug }, props: { post: p } }));
}
const { post } = Astro.props;
---
<h1>{post.data.title}</h1>
<article set:html={post.rendered.html} />`;

		const site = new MemorySite();
		site.write("/src/pages/blog/[slug].astro", enc(RENDERED_ROUTE));
		site.write(
			"/src/content/blog/article.md",
			enc(
				"---\ntitle: The Article\n---\n" +
					"## Section\n\n" +
					"Body with **bold** and a [link](https://example.com).\n\n" +
					"```js\nconst x = 1;\n```\n",
			),
		);

		const executor = makeExecutor();
		const produced = (
			await collect(buildSite({ site, executor, markdown: { shiki: true } }))
		).filter((x): x is SnapshotEntry => "bytes" in x);
		const html = new Map(produced.map((e) => [e.route, new TextDecoder().decode(e.bytes)])).get(
			"/blog/article",
		) as string;

		expect(html).toContain("<h1>The Article</h1>");
		expect(html).toContain("<h2>Section</h2>");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain('<a href="https://example.com">link</a>');
		// Shiki highlighting flowed through buildSite's markdown config.
		expect(html).toContain("<span style=");
		// Not the literal markdown source.
		expect(html).not.toContain("## Section");
	});

	it("editing an entry body re-renders rendered.html on the next build (digest fold)", async () => {
		const RENDERED_ROUTE = `---
import { getCollection } from 'astro:content';
export async function getStaticPaths() {
	const posts = await getCollection('blog');
	return posts.map((p) => ({ params: { slug: p.slug }, props: { post: p } }));
}
const { post } = Astro.props;
---
<article set:html={post.rendered.html} />`;
		const executor = makeExecutor();
		const site = new MemorySite();
		site.write("/src/pages/blog/[slug].astro", enc(RENDERED_ROUTE));
		site.write("/src/content/blog/p.md", enc("---\ntitle: P\n---\noriginal body\n"));

		const first = new Map(
			(await collect(buildSite({ site, executor })))
				.filter((x): x is SnapshotEntry => "bytes" in x)
				.map((e) => [e.route, new TextDecoder().decode(e.bytes)]),
		);
		expect(first.get("/blog/p")).toContain("<p>original body</p>");

		// Same route bytes; only the entry body changed. The content
		// digest fold must bust the cached isolate so the new HTML wins.
		site.write("/src/content/blog/p.md", enc("---\ntitle: P\n---\n**updated** body\n"));
		const second = new Map(
			(await collect(buildSite({ site, executor })))
				.filter((x): x is SnapshotEntry => "bytes" in x)
				.map((e) => [e.route, new TextDecoder().decode(e.bytes)]),
		);
		expect(second.get("/blog/p")).toContain("<strong>updated</strong> body");
		expect(second.get("/blog/p")).not.toContain("original body");
	});

	it("is zero-cost when the project has no /src/content/", async () => {
		const site = new MemorySite();
		site.write("/src/pages/index.astro", enc("---\nconst x = 'plain';\n---\n<h1>{x}</h1>"));
		const executor = makeExecutor();
		const produced = (await collect(buildSite({ site, executor }))).filter(
			(x): x is SnapshotEntry => "bytes" in x,
		);
		expect(produced.map((e) => e.route)).toEqual(["/"]);
		expect(new TextDecoder().decode(produced[0]?.bytes ?? new Uint8Array())).toContain("plain");
	});
});
