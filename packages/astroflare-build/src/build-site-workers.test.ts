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
 *   - dynamic `[slug].astro` routes throw the same error as the Node
 *     version (no `getStaticPaths` support yet)
 *   - missing pages glob → no entries (graceful empty-site case)
 */
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
	const dist = path.resolve(here, "../../astroflare-runtime/dist");
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

	it("throws on dynamic [slug] routes (no getStaticPaths support)", async () => {
		const site = new MemorySite();
		site.write("/src/pages/posts/[slug].astro", enc("---\n---\n<h1>post</h1>"));
		const executor = makeExecutor();
		const iter = buildSite({ site, executor });
		await expect(async () => {
			for await (const _ of iter) {
				// drain
			}
		}).rejects.toThrow(/dynamic routes.*not yet supported/);
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
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of iter) out.push(x);
	return out;
}
