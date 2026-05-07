/**
 * Workers-runtime `buildSite` end-to-end inside workerd.
 *
 * The Phase 26b validation is "compile + render + publish all from
 * inside a Worker." This spec wires the production-shape pieces:
 *
 *   - `WorkspaceSite` (the host-cloudflare-flavoured `Site`) seeded
 *     with a couple of `.astro` pages,
 *   - `createWorkerdExecutor` over the workerd `LOADER` binding, with
 *     the runtime modules merged in (matches how production hosts
 *     embed Astroflare),
 *   - `buildSite` walking the pages and yielding `SnapshotEntry`s,
 *   - `R2SnapshotSink` writing them into a real (miniflare) R2
 *     bucket,
 *   - `R2Snapshots` + `createSnapshotHandler` serving the result,
 *
 * then asserts every produced route serves byte-identical content
 * via the snapshot handler. This is the round-trip Ember (and any
 * other host doing in-Worker publishes) needs to know works.
 */

import { env } from "cloudflare:test";
import { buildSite, createSnapshotHandler } from "@astroflare/build";
import type { BuildSiteOutput, SnapshotEntry, SnapshotError } from "@astroflare/core";
import {
	R2SnapshotSink,
	R2Snapshots,
	type SqlBackend,
	type WorkspaceLike,
	WorkspaceSite,
	createWorkerdExecutor,
} from "@astroflare/host-cloudflare";
import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/ban-ts-comment */
// Same `?raw` pattern as `compiler-e2e.test.ts` — pull the runtime
// dist into the spawned isolate's module map so `./runtime/index.js`
// resolves at compile + render time.
// @ts-expect-error
import RUNTIME_COMPONENTS_SRC from "../../packages/runtime/dist/components.js?raw";
// @ts-expect-error
import RUNTIME_COOKIES_SRC from "../../packages/runtime/dist/cookies.js?raw";
// @ts-expect-error
import RUNTIME_ENV_SRC from "../../packages/runtime/dist/env.js?raw";
// @ts-expect-error
import RUNTIME_ERROR_OVERLAY_SRC from "../../packages/runtime/dist/error-overlay.js?raw";
// @ts-expect-error
import RUNTIME_HMR_SRC from "../../packages/runtime/dist/hmr-client.js?raw";
// @ts-expect-error
import RUNTIME_HYDRATION_SRC from "../../packages/runtime/dist/hydration-client.js?raw";
// @ts-expect-error
import RUNTIME_I18N_SRC from "../../packages/runtime/dist/i18n.js?raw";
// @ts-expect-error
import RUNTIME_INDEX_SRC from "../../packages/runtime/dist/index.js?raw";
// @ts-expect-error
import RUNTIME_INTERNAL_SRC from "../../packages/runtime/dist/internal.js?raw";
// @ts-expect-error
import RUNTIME_JSX_RUNTIME_SRC from "../../packages/runtime/dist/jsx-runtime.js?raw";
// @ts-expect-error
import RUNTIME_PREFETCH_SRC from "../../packages/runtime/dist/prefetch-client.js?raw";
// @ts-expect-error
import RUNTIME_REACT_ADAPTER_SRC from "../../packages/runtime/dist/react-adapter.js?raw";
// @ts-expect-error
import RUNTIME_REACT_SSR_SRC from "../../packages/runtime/dist/react-ssr.js?raw";
// @ts-expect-error
import RUNTIME_RENDER_SRC from "../../packages/runtime/dist/render.js?raw";
// @ts-expect-error
import RUNTIME_RSS_SRC from "../../packages/runtime/dist/rss.js?raw";
// @ts-expect-error
import RUNTIME_SITEMAP_SRC from "../../packages/runtime/dist/sitemap.js?raw";
// @ts-expect-error
import RUNTIME_VT_SRC from "../../packages/runtime/dist/view-transitions-client.js?raw";

const RUNTIME_MODULES: Record<string, string> = {
	"runtime/index.js": RUNTIME_INDEX_SRC as string,
	"runtime/internal.js": RUNTIME_INTERNAL_SRC as string,
	"runtime/render.js": RUNTIME_RENDER_SRC as string,
	"runtime/hmr-client.js": RUNTIME_HMR_SRC as string,
	"runtime/cookies.js": RUNTIME_COOKIES_SRC as string,
	"runtime/components.js": RUNTIME_COMPONENTS_SRC as string,
	"runtime/jsx-runtime.js": RUNTIME_JSX_RUNTIME_SRC as string,
	"runtime/env.js": RUNTIME_ENV_SRC as string,
	"runtime/hydration-client.js": RUNTIME_HYDRATION_SRC as string,
	"runtime/view-transitions-client.js": RUNTIME_VT_SRC as string,
	"runtime/prefetch-client.js": RUNTIME_PREFETCH_SRC as string,
	"runtime/rss.js": RUNTIME_RSS_SRC as string,
	"runtime/sitemap.js": RUNTIME_SITEMAP_SRC as string,
	"runtime/i18n.js": RUNTIME_I18N_SRC as string,
	"runtime/error-overlay.js": RUNTIME_ERROR_OVERLAY_SRC as string,
	"runtime/react-adapter.js": RUNTIME_REACT_ADAPTER_SRC as string,
	"runtime/react-ssr.js": RUNTIME_REACT_SSR_SRC as string,
};

/**
 * In-Worker SQL stand-in for `WorkspaceSite`'s hash sidecar. The DO-
 * sqlite shape is overkill for a fan-in test; the literal-query mock
 * mirrors the one in `workspace-site.test.ts` (Layer A).
 */
function makeMockSql(): SqlBackend {
	const hashes = new Map<string, string>();
	let initialized = false;
	return {
		exec<T>(query: string, ...bindings: unknown[]): { toArray(): T[] } {
			const q = query.trim();
			if (q.startsWith("CREATE TABLE")) {
				initialized = true;
				return { toArray: () => [] };
			}
			if (!initialized) throw new Error("schema not initialized");
			if (q.startsWith("SELECT hash FROM aflare_hash WHERE path = ?")) {
				const path = bindings[0] as string;
				const hash = hashes.get(path);
				const rows = hash ? [{ hash }] : [];
				return { toArray: () => rows as T[] };
			}
			if (q.startsWith("INSERT OR REPLACE INTO aflare_hash")) {
				const [path, hash] = bindings as [string, string];
				hashes.set(path, hash);
				return { toArray: () => [] };
			}
			if (q.startsWith("DELETE FROM aflare_hash WHERE path = ?")) {
				hashes.delete(bindings[0] as string);
				return { toArray: () => [] };
			}
			throw new Error(`unhandled query: ${q}`);
		},
	};
}

function makeMockWorkspace(): WorkspaceLike & { files: Map<string, Uint8Array> } {
	const files = new Map<string, Uint8Array>();
	return {
		files,
		async readFileBytes(path) {
			return files.get(path) ?? null;
		},
		async writeFileBytes(path, bytes) {
			const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBufferLike);
			files.set(path, new Uint8Array(u));
		},
		async deleteFile(path) {
			return files.delete(path);
		},
		async stat(path) {
			const f = files.get(path);
			return f ? { size: f.byteLength } : null;
		},
		async glob(pattern) {
			// Minimal: convert `**` to wildcard, strip globbing, suffix-match.
			const out: { path: string }[] = [];
			const ext = pattern.match(/\.([a-z0-9]+)$/i)?.[0] ?? "";
			const prefix = pattern.replace(/\*+\/.*$/, "").replace(/\*+$/, "");
			for (const k of files.keys()) {
				if (prefix && !k.startsWith(prefix)) continue;
				if (ext && !k.endsWith(ext)) continue;
				out.push({ path: k });
			}
			return out;
		},
	};
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("buildSite + R2 round-trip inside workerd", () => {
	it("compiles, publishes, and serves every route via createSnapshotHandler", async () => {
		const ws = makeMockWorkspace();
		const sql = makeMockSql();
		const site = new WorkspaceSite({ workspace: ws, sql });

		// Seed a couple of pages — index + nested + about. All match the
		// `/src/pages/**/*.astro` glob the framework's buildSite walks.
		await site.write(
			"/src/pages/index.astro",
			enc('---\nconst greeting = "hello workerd";\n---\n<h1>{greeting}</h1>'),
		);
		await site.write("/src/pages/about.astro", enc("---\n---\n<h1>about</h1>"));
		await site.write(
			"/src/pages/blog/index.astro",
			enc('---\nconst x = "blog index";\n---\n<p>{x}</p>'),
		);

		const executor = createWorkerdExecutor({
			loader: env.LOADER,
			compatibilityDate: "2025-09-01",
			compatibilityFlags: ["nodejs_compat"],
			runtime: RUNTIME_MODULES,
		});

		// Build → R2.
		const sink = new R2SnapshotSink({ bucket: env.SITE_R2, prefix: "sites/test/" });
		const snapshotHash = "test-snap-1";
		const produced: SnapshotEntry[] = [];
		for await (const entry of buildSite({ site, executor })) {
			produced.push(entry);
			await sink.put(snapshotHash, entry);
		}
		await sink.commit(snapshotHash);

		expect(produced).toHaveLength(3);
		const routes = produced.map((p) => p.route).sort();
		expect(routes).toEqual(["/", "/about", "/blog"]);

		// Read back via createSnapshotHandler. Each produced entry must
		// serve byte-identical content.
		const snapshots = new R2Snapshots({ bucket: env.SITE_R2, prefix: "sites/test/" });
		const handler = createSnapshotHandler({ snapshots });
		expect(await snapshots.current()).toBe(snapshotHash);

		for (const entry of produced) {
			const res = await handler.fetch(new Request(`https://x${entry.route}`));
			expect(res.status, `serving ${entry.route}`).toBe(200);
			expect(res.headers.get("content-type")).toBe(entry.contentType);
			const got = new Uint8Array(await res.arrayBuffer());
			expect(got).toEqual(entry.bytes);
		}

		// And: the index page actually rendered the frontmatter.
		const indexRes = await handler.fetch(new Request("https://x/"));
		const html = await indexRes.text();
		expect(html).toContain("hello workerd");
	});

	// Lock-step parity with `createPreviewHandler` (Mode A) for the JSX-
	// in-expression body shape that PR #12's parser swap and PR #13's
	// emitter wiring (sucrase JSX transform → `$$jsx` runtime pragma)
	// added end-to-end. If the workers-runtime `buildSite` path doesn't
	// also lower `<li>{x}</li>` correctly, preview and publish render
	// different HTML — exactly the regression Ember reported in round 8.
	it("renders JSX-in-expression bodies in the workers-runtime buildSite path", async () => {
		const ws = makeMockWorkspace();
		const sql = makeMockSql();
		const site = new WorkspaceSite({ workspace: ws, sql });

		await site.write(
			"/src/pages/index.astro",
			enc('---\nconst items = ["a", "b"];\n---\n<ul>{items.map((x) => (<li>{x}</li>))}</ul>'),
		);

		const executor = createWorkerdExecutor({
			loader: env.LOADER,
			compatibilityDate: "2025-09-01",
			compatibilityFlags: ["nodejs_compat"],
			runtime: RUNTIME_MODULES,
		});

		const sink = new R2SnapshotSink({ bucket: env.SITE_R2, prefix: "sites/jsx/" });
		const hash = "jsx-snap-1";
		const produced: SnapshotEntry[] = [];
		for await (const entry of buildSite({ site, executor })) {
			produced.push(entry);
			await sink.put(hash, entry);
		}
		await sink.commit(hash);

		expect(produced).toHaveLength(1);

		const snapshots = new R2Snapshots({ bucket: env.SITE_R2, prefix: "sites/jsx/" });
		const handler = createSnapshotHandler({ snapshots });
		const res = await handler.fetch(new Request("https://x/"));
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>a</li>");
		expect(html).toContain("<li>b</li>");
	});

	// `continueOnError` is the agent-facing diagnostic mode: instead of
	// aborting on the first broken page, the build yields a
	// `SnapshotError` for each failure and keeps going. Same pipeline,
	// same executor, same workerd runtime — just a different consumer
	// shape. Lets a host's "check_site" tool collect every error in one
	// pass so the LLM can fix them all in a single round-trip.
	it("yields SnapshotErrors for broken pages and SnapshotEntries for healthy ones in a single pass", async () => {
		const ws = makeMockWorkspace();
		const sql = makeMockSql();
		const site = new WorkspaceSite({ workspace: ws, sql });

		// One healthy page + three broken-in-different-ways pages.
		await site.write("/src/pages/index.astro", enc("---\n---\n<h1>good</h1>"));
		await site.write("/src/pages/bad-compile.astro", enc("<p>{unclosed"));
		await site.write(
			"/src/pages/bad-paths/[slug].astro",
			enc(`---
export async function getStaticPaths() { throw new Error("paths boom"); }
---
<h1>x</h1>`),
		);
		await site.write(
			"/src/pages/bad-render/[slug].astro",
			enc(`---
export async function getStaticPaths() {
	return [
		{ params: { slug: "ok" }, props: { mode: "ok" } },
		{ params: { slug: "boom" }, props: { mode: "boom" } },
	];
}
const { mode } = Astro.props;
const { slug } = Astro.params;
if (mode === "boom") throw new Error("render boom");
---
<p>{slug}</p>`),
		);

		const executor = createWorkerdExecutor({
			loader: env.LOADER,
			compatibilityDate: "2025-09-01",
			compatibilityFlags: ["nodejs_compat"],
			runtime: RUNTIME_MODULES,
		});

		const out: BuildSiteOutput[] = [];
		for await (const x of buildSite({ site, executor, continueOnError: true })) {
			out.push(x);
		}

		const entries = out.filter((x): x is SnapshotEntry => "bytes" in x);
		const errors = out.filter(
			(x): x is SnapshotError => "kind" in x && (x as SnapshotError).kind === "error",
		);

		// /index + /bad-render/ok render fine.
		expect(entries.map((e) => e.route).sort()).toEqual(["/", "/bad-render/ok"]);
		// One per broken page, plus one per failed dynamic-route entry.
		expect(errors).toHaveLength(3);

		const phases = errors.map((e) => e.phase).sort();
		expect(phases).toEqual(["compile", "getStaticPaths", "render"]);

		const compileErr = errors.find((e) => e.phase === "compile");
		expect(compileErr?.sourcePath).toBe("/src/pages/bad-compile.astro");

		const pathsErr = errors.find((e) => e.phase === "getStaticPaths");
		expect(pathsErr?.sourcePath).toBe("/src/pages/bad-paths/[slug].astro");
		expect(pathsErr?.message).toMatch(/getStaticPaths failed.*paths boom/);

		const renderErr = errors.find((e) => e.phase === "render");
		expect(renderErr?.sourcePath).toBe("/src/pages/bad-render/[slug].astro");
		expect(renderErr?.route).toBe("/bad-render/boom");
		expect(renderErr?.params).toEqual({ slug: "boom" });
	});

	// Default mode (no continueOnError flag) keeps the existing
	// throw-on-first-error semantics — the publish pipelines that pipe
	// `buildSite` straight into a `R2SnapshotSink` rely on this.
	it("aborts on first error when continueOnError is unset", async () => {
		const ws = makeMockWorkspace();
		const sql = makeMockSql();
		const site = new WorkspaceSite({ workspace: ws, sql });

		await site.write("/src/pages/bad.astro", enc("<p>{unclosed"));

		const executor = createWorkerdExecutor({
			loader: env.LOADER,
			compatibilityDate: "2025-09-01",
			compatibilityFlags: ["nodejs_compat"],
			runtime: RUNTIME_MODULES,
		});

		await expect(
			(async () => {
				for await (const _ of buildSite({ site, executor })) {
					/* drain */
				}
			})(),
		).rejects.toThrow(/compile failed for \/src\/pages\/bad\.astro/);
	});
});
