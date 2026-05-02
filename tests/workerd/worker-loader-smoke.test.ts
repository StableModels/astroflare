/**
 * Worker Loader smoke test — proves the Phase 2.5b unblock landed.
 *
 * Phase 2.5 retro thought Miniflare didn't expose `workerLoaders`. It does,
 * since v4.20250823 (PR #10012). We just had to bump the
 * `@cloudflare/vitest-pool-workers` minor (the v4 Miniflare came along
 * transitively). With `workerLoaders: { LOADER: {} }` configured in the
 * vitest pool's miniflare options (see `vitest.config.ts`), every test in
 * this pool gets `env.LOADER` typed as `WorkerLoader` (see
 * `cloudflare-test.d.ts`).
 *
 * Note on the API surface: `@cloudflare/workers-types` declares both
 * `load(code)` and `get(name, getCode)`. The actual workerd binary in
 * Miniflare v4.20251210 only ships `get` — `load(code)` is effectively
 * `get(null, () => code)` (the brief's §4 description blurs the two).
 * We use `get` exclusively.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Helper: spawn-once is `get(null, …)` per workerd convention.
const COMPATIBILITY_DATE = "2025-09-01";

describe("Worker Loader (Miniflare v4) smoke", () => {
	it("env.LOADER is bound", () => {
		expect(typeof env.LOADER).toBe("object");
		expect(typeof env.LOADER.get).toBe("function");
	});

	it("get(null, factory) spawns a child Worker that responds to fetch", async () => {
		const stub = env.LOADER.get(null, () => ({
			compatibilityDate: COMPATIBILITY_DATE,
			mainModule: "main.js",
			modules: {
				"main.js": `
					export default {
						fetch(req) { return new Response("hello from loaded worker"); },
					};
				`,
			},
		}));
		const r = await stub.getEntrypoint().fetch("https://internal/");
		expect(r.status).toBe(200);
		expect(await r.text()).toBe("hello from loaded worker");
	});

	it("get(name, factory) caches by name — module state persists across fetches", async () => {
		const getCode = () => ({
			compatibilityDate: COMPATIBILITY_DATE,
			mainModule: "main.js",
			modules: {
				"main.js": `
					let counter = 0;
					export default {
						fetch() { counter += 1; return new Response(String(counter)); },
					};
				`,
			},
		});
		const stub = env.LOADER.get("smoke-cached", getCode);
		const ep = stub.getEntrypoint();
		const r1 = await ep.fetch("https://internal/");
		const r2 = await ep.fetch("https://internal/");
		expect(await r1.text()).toBe("1");
		expect(await r2.text()).toBe("2");
	});

	it("different ids spawn different isolates (counters don't share)", async () => {
		const getCode = () => ({
			compatibilityDate: COMPATIBILITY_DATE,
			mainModule: "main.js",
			modules: {
				"main.js": `
					let n = 0;
					export default {
						fetch() { n += 1; return new Response(String(n)); },
					};
				`,
			},
		});

		const a = env.LOADER.get("smoke-a", getCode);
		const b = env.LOADER.get("smoke-b", getCode);
		await a.getEntrypoint().fetch("https://internal/");
		await a.getEntrypoint().fetch("https://internal/");
		const aR = await a.getEntrypoint().fetch("https://internal/");
		const bR = await b.getEntrypoint().fetch("https://internal/");
		expect(await aR.text()).toBe("3");
		expect(await bR.text()).toBe("1");
	});

	it("multi-module bundle: route imports a helper file and the helper resolves", async () => {
		const stub = env.LOADER.get(null, () => ({
			compatibilityDate: COMPATIBILITY_DATE,
			mainModule: "main.js",
			modules: {
				"main.js": `
					import { greet } from "./greet.js";
					export default {
						fetch(req) { return new Response(greet("world")); },
					};
				`,
				"greet.js": `
					export const greet = (name) => "hello, " + name;
				`,
			},
		}));
		const r = await stub.getEntrypoint().fetch("https://internal/");
		expect(await r.text()).toBe("hello, world");
	});
});
