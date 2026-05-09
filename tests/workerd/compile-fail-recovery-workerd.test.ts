/**
 * Compile-fail recovery flow inside workerd.
 *
 * The "stop stranding the iframe on a compile error" guarantee has
 * three moving parts; this spec exercises them end-to-end against the
 * production-shape pieces:
 *
 *   1. {@link createCoordinator} pre-flights the compile when
 *      `notifyChanged({ verifyCompile: true })` is called and substitutes
 *      an HMR `error` for `update` when the compile throws — verified
 *      against the diagnostic ring buffer.
 *   2. The iframe holding an HMR socket gets `error` instead of
 *      `update`, so the existing render stays put — no auto-reload, no
 *      blank screen — while the dev overlay surfaces the compile
 *      diagnostic on top of it.
 *   3. {@link createPreviewHandler} injects the HMR client into 500
 *      responses, so a *manual* reload onto a broken page still
 *      attaches a live socket and recovers on the next clean change.
 *
 * Then a clean follow-up write + `notifyChanged({ verifyCompile: true })`
 * publishes a normal `update` and the route renders the fixed source.
 */

import { env } from "cloudflare:test";
import {
	type SqlBackend,
	type WorkspaceLike,
	WorkspaceSite,
	createCoordinator,
	createPreviewHandler,
	createWorkerdExecutor,
} from "@astroflare/host-cloudflare";
import { ModuleGraph } from "@astroflare/preview/module-graph";
import { MemoryCache } from "@astroflare/test-utils/in-memory";
import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/ban-ts-comment */
// Re-import the dist bundles the way `build-site-workerd.test.ts` does
// — `?raw` text so the spawned isolate can resolve `./runtime/index.js`.
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

function makeMockSql(): SqlBackend {
	const tables = new Map<string, Map<string, Record<string, unknown>>>();
	const ensure = (name: string) => {
		if (!tables.has(name)) tables.set(name, new Map());
		return tables.get(name) as Map<string, Record<string, unknown>>;
	};
	let initialized = false;
	return {
		exec<T>(query: string, ...bindings: unknown[]): { toArray(): T[] } {
			const q = query.trim();
			if (q.startsWith("CREATE TABLE") || q.startsWith("CREATE INDEX")) {
				initialized = true;
				return { toArray: () => [] };
			}
			if (!initialized) throw new Error(`schema not initialized: ${q.slice(0, 60)}`);
			if (q.startsWith("SELECT path, hash, imports_json FROM aflare_module_graph WHERE path = ?")) {
				const path = bindings[0] as string;
				const row = ensure("aflare_module_graph").get(path);
				return { toArray: () => (row ? [row] : []) } as { toArray(): T[] };
			}
			if (q.startsWith("SELECT path, hash, imports_json FROM aflare_module_graph ORDER BY path")) {
				const rows = Array.from(ensure("aflare_module_graph").values()).sort((a, b) =>
					(a.path as string).localeCompare(b.path as string),
				);
				return { toArray: () => rows } as { toArray(): T[] };
			}
			if (q.startsWith("INSERT OR REPLACE INTO aflare_module_graph")) {
				const [path, hash, imports_json] = bindings as [string, string, string];
				ensure("aflare_module_graph").set(path, { path, hash, imports_json });
				return { toArray: () => [] };
			}
			if (q.startsWith("UPDATE aflare_module_graph SET imports_json = ? WHERE path = ?")) {
				const [imports_json, path] = bindings as [string, string];
				const existing = ensure("aflare_module_graph").get(path);
				if (existing) ensure("aflare_module_graph").set(path, { ...existing, imports_json });
				return { toArray: () => [] };
			}
			if (q.startsWith("DELETE FROM aflare_module_graph WHERE path = ?")) {
				ensure("aflare_module_graph").delete(bindings[0] as string);
				return { toArray: () => [] };
			}
			if (q.startsWith("SELECT importer FROM aflare_module_imported_by WHERE path = ?")) {
				const path = bindings[0] as string;
				const ib = ensure("aflare_module_imported_by");
				const out: { importer: string }[] = [];
				for (const k of ib.keys()) {
					if (k.startsWith(`${path}|`)) out.push({ importer: k.slice(path.length + 1) });
				}
				return { toArray: () => out } as { toArray(): T[] };
			}
			if (q.startsWith("INSERT OR IGNORE INTO aflare_module_imported_by")) {
				const [path, importer] = bindings as [string, string];
				ensure("aflare_module_imported_by").set(`${path}|${importer}`, { path, importer });
				return { toArray: () => [] };
			}
			if (q.startsWith("DELETE FROM aflare_module_imported_by WHERE path = ? AND importer = ?")) {
				const [path, importer] = bindings as [string, string];
				ensure("aflare_module_imported_by").delete(`${path}|${importer}`);
				return { toArray: () => [] };
			}
			if (q.startsWith("DELETE FROM aflare_module_imported_by WHERE path = ?")) {
				const ib = ensure("aflare_module_imported_by");
				const path = bindings[0] as string;
				for (const k of Array.from(ib.keys())) {
					if (k.startsWith(`${path}|`)) ib.delete(k);
				}
				return { toArray: () => [] };
			}
			if (q.startsWith("SELECT hash FROM aflare_hash WHERE path = ?")) {
				const path = bindings[0] as string;
				const row = ensure("aflare_hash").get(path);
				return { toArray: () => (row ? [row] : []) } as { toArray(): T[] };
			}
			if (q.startsWith("INSERT OR REPLACE INTO aflare_hash")) {
				const [path, hash] = bindings as [string, string];
				ensure("aflare_hash").set(path, { path, hash });
				return { toArray: () => [] };
			}
			if (q.startsWith("DELETE FROM aflare_hash WHERE path = ?")) {
				ensure("aflare_hash").delete(bindings[0] as string);
				return { toArray: () => [] };
			}
			throw new Error(`unhandled query: ${q.slice(0, 80)}`);
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

const GOOD_SOURCE = '---\nconst greeting = "hello recovery";\n---\n<h1>{greeting}</h1>';
const BROKEN_SOURCE = "---\nconst x: = 5;\n---\n<p>broken</p>";
const FIXED_SOURCE = '---\nconst greeting = "fixed up";\n---\n<h1>{greeting}</h1>';

describe("compile-fail recovery via coordinator pre-flight + handler envelope", () => {
	it("publishes HMR error on broken write, keeps prior render alive, recovers on clean write", async () => {
		const ws = makeMockWorkspace();
		const sql = makeMockSql();
		const site = new WorkspaceSite({ workspace: ws, sql });
		const cache = new MemoryCache();

		const executor = createWorkerdExecutor({
			loader: env.LOADER,
			compatibilityDate: "2025-09-01",
			compatibilityFlags: ["nodejs_compat"],
			runtime: RUNTIME_MODULES,
		});

		// One graph + module-graph instance is shared between the
		// coordinator's pre-flight and the handler's render path so a
		// successful pre-flight populates the same compile cache the
		// handler walks. (Production wiring matches this — the host
		// constructs both inside its DO.)
		const moduleGraph = new ModuleGraph({ site, cache }, { runtimeImport: "./runtime/index.js" });

		const coordinator = createCoordinator({
			sql,
			compile: async (path) => {
				await moduleGraph.compile(path);
			},
		});

		const handler = createPreviewHandler({
			site,
			coordinator,
			executor,
			cache,
			// Re-use the pre-warmed graph so the handler doesn't
			// re-instantiate a fresh one (which would fight the
			// coordinator's pre-flight cache).
			resolveRoute: (pathname) => (pathname === "/" ? "/src/pages/index.astro" : null),
		});

		// Seed a working page + cache the executor result by hitting
		// the handler once.
		await site.write("/src/pages/index.astro", enc(GOOD_SOURCE));
		const before = await handler.fetch(new Request("https://app/"));
		expect(before.status, await before.clone().text()).toBe(200);
		expect(await before.text()).toContain("hello recovery");

		// Now write broken bytes and ask the coordinator to verify before
		// publishing. The pre-flight should compile-fail, swap `update`
		// for `error`, and the ring buffer must reflect that.
		await site.write("/src/pages/index.astro", enc(BROKEN_SOURCE));
		await coordinator.notifyChanged(
			{ kind: "write", path: "/src/pages/index.astro", hash: "broken" },
			{ verifyCompile: true },
		);

		const events = coordinator.recentHmrEvents();
		expect(events).toHaveLength(1);
		const broken = events[0]?.message;
		if (broken?.type !== "error") throw new Error("expected error event");
		expect(broken.error.path).toBe("/src/pages/index.astro");
		// Structured diagnostics flow through — the dev overlay can render
		// the code frame on top of the prior good render.
		expect(broken.error.diagnostics).toBeDefined();
		expect(broken.error.codeFrame?.text).toBeDefined();

		// A direct fetch hits the broken bytes, but the handler still
		// dresses the 500 in an HTML envelope with the HMR client
		// injected — a manually reloaded iframe keeps a live socket.
		const broken500 = await handler.fetch(new Request("https://app/"));
		expect(broken500.status).toBe(500);
		expect(broken500.headers.get("content-type")).toContain("text/html");
		const brokenBody = await broken500.text();
		expect(brokenBody).toContain('<script type="module">');
		expect(brokenBody).toContain("/_aflare/hmr");

		// Fix the file + re-notify with verifyCompile. Pre-flight is
		// clean so the historical update path runs.
		await site.write("/src/pages/index.astro", enc(FIXED_SOURCE));
		await coordinator.notifyChanged(
			{ kind: "write", path: "/src/pages/index.astro", hash: "fixed" },
			{ verifyCompile: true },
		);
		const fixedEvents = coordinator.recentHmrEvents();
		expect(fixedEvents).toHaveLength(2);
		const recover = fixedEvents[1]?.message;
		expect(recover?.type).toBe("update");

		const after = await handler.fetch(new Request("https://app/"));
		expect(after.status, await after.clone().text()).toBe(200);
		expect(await after.text()).toContain("fixed up");
	});
});
