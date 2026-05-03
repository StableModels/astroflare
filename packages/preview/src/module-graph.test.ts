import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type TestHost, createTestHost } from "@astroflare/test-utils";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ModuleGraph } from "./module-graph.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIST = path.resolve(__dirname, "../../runtime/dist/index.js");
const RUNTIME_URL = pathToFileURL(RUNTIME_DIST).href;

const enc = (s: string) => new TextEncoder().encode(s);

beforeAll(() => {
	if (!existsSync(RUNTIME_DIST)) {
		throw new Error(`Runtime dist not found at ${RUNTIME_DIST}. Run \`pnpm typecheck\`.`);
	}
});

const active: TestHost[] = [];
afterEach(async () => {
	await Promise.all(active.splice(0).map((h) => h.dispose()));
});

function makeFixture(files: Record<string, string>): {
	host: TestHost;
	graph: ModuleGraph;
} {
	const host = createTestHost();
	active.push(host);
	for (const [p, body] of Object.entries(files)) {
		host.site.write(p, enc(body));
	}
	const graph = new ModuleGraph(host, { runtimeImport: RUNTIME_URL });
	return { host, graph };
}

describe("ModuleGraph.compile", () => {
	it("compiles a single .astro file and caches by content+config", async () => {
		const { host, graph } = makeFixture({
			"/src/pages/index.astro": "<p>hi</p>",
		});

		const a = await graph.compile("/src/pages/index.astro");
		expect(a.compiled).toContain("$component(");

		// Second call hits the in-process compile cache (no extra storage cache writes).
		const writesBefore = host.cache.keys().length;
		const b = await graph.compile("/src/pages/index.astro");
		expect(b.compiled).toBe(a.compiled);
		// Key wasn't added a second time — same id maps to same bytes.
		expect(host.cache.keys().length).toBe(writesBefore);

		// Both calls produced one cache.hit + one cache.write event.
		expect(host.logger.byName("module-graph.compile")).toHaveLength(1);
		expect(host.logger.byName("module-graph.cache.hit")).toHaveLength(1);
	});

	it("cache key changes when source changes", async () => {
		const { host, graph } = makeFixture({
			"/src/pages/x.astro": "<p>v1</p>",
		});
		const a = await graph.compile("/src/pages/x.astro");
		host.site.write("/src/pages/x.astro", enc("<p>v2</p>"));
		const b = await graph.compile("/src/pages/x.astro");
		expect(a.compileKey).not.toBe(b.compileKey);
	});

	it("populates Coordinator graph with imports", async () => {
		const { host, graph } = makeFixture({
			"/src/pages/index.astro":
				'---\nimport Layout from "../components/Layout.astro";\n---\n<Layout>x</Layout>',
			"/src/components/Layout.astro": "<header><slot/></header>",
		});
		await graph.compile("/src/pages/index.astro");
		const node = await host.coordinator.graphGet("/src/pages/index.astro");
		expect(node?.imports).toEqual(["/src/components/Layout.astro"]);
	});

	it("throws on compile error with file path in message", async () => {
		const { graph } = makeFixture({
			"/src/pages/bad.astro": "<p>{unclosed",
		});
		await expect(graph.compile("/src/pages/bad.astro")).rejects.toThrow(
			/compile error in \/src\/pages\/bad\.astro/,
		);
	});

	it("dedupes concurrent compiles of the same path (no double-write)", async () => {
		const { host, graph } = makeFixture({
			"/src/pages/x.astro": "<p>x</p>",
		});
		// Kick off both before either completes.
		const [a, b] = await Promise.all([
			graph.compile("/src/pages/x.astro"),
			graph.compile("/src/pages/x.astro"),
		]);
		expect(a).toBe(b); // same record returned to both callers
		// One compile, no double cache.hit either (the second wasn't a separate path through).
		expect(host.logger.byName("module-graph.compile")).toHaveLength(1);
	});
});

describe("ModuleGraph.closure", () => {
	it("walks transitive .astro imports", async () => {
		const { graph } = makeFixture({
			"/src/pages/index.astro":
				'---\nimport Layout from "../components/Layout.astro";\n---\n<Layout/>',
			"/src/components/Layout.astro": '---\nimport Button from "./Button.astro";\n---\n<Button/>',
			"/src/components/Button.astro": "<button>x</button>",
		});
		const closure = await graph.closure("/src/pages/index.astro");
		const paths = closure.modules.map((m) => m.path);
		expect(paths).toEqual([
			"/src/pages/index.astro",
			"/src/components/Layout.astro",
			"/src/components/Button.astro",
		]);
	});

	it("each module appears once in the closure (diamond imports)", async () => {
		const { graph } = makeFixture({
			"/src/pages/index.astro":
				"---\n" +
				'import A from "../components/A.astro";\n' +
				'import B from "../components/B.astro";\n' +
				"---\n<A/><B/>",
			"/src/components/A.astro": '---\nimport Shared from "./Shared.astro";\n---\n<Shared/>',
			"/src/components/B.astro": '---\nimport Shared from "./Shared.astro";\n---\n<Shared/>',
			"/src/components/Shared.astro": "<p>shared</p>",
		});
		const closure = await graph.closure("/src/pages/index.astro");
		const paths = closure.modules.map((m) => m.path);
		expect(new Set(paths).size).toBe(paths.length); // no dupes
		expect(paths).toContain("/src/components/Shared.astro");
	});

	it("bundleKey is stable when sources don't change", async () => {
		const { graph } = makeFixture({
			"/src/pages/x.astro": '---\nimport L from "../components/L.astro";\n---\n<L/>',
			"/src/components/L.astro": "<p>x</p>",
		});
		const a = await graph.closure("/src/pages/x.astro");
		const b = await graph.closure("/src/pages/x.astro");
		expect(a.bundleKey).toBe(b.bundleKey);
	});

	it("bundleKey changes when a dep's source changes", async () => {
		const { host, graph } = makeFixture({
			"/src/pages/x.astro": '---\nimport L from "../components/L.astro";\n---\n<L/>',
			"/src/components/L.astro": "<p>v1</p>",
		});
		const a = await graph.closure("/src/pages/x.astro");
		host.site.write("/src/components/L.astro", enc("<p>v2</p>"));
		const b = await graph.closure("/src/pages/x.astro");
		expect(a.bundleKey).not.toBe(b.bundleKey);
	});

	it("survives import cycles", async () => {
		// A cycle is uncommon in practice but shouldn't infinitely loop.
		const { graph } = makeFixture({
			"/src/pages/a.astro": '---\nimport B from "./b.astro";\n---\n<B/>',
			"/src/pages/b.astro": '---\nimport A from "./a.astro";\n---\n<A/>',
		});
		const closure = await graph.closure("/src/pages/a.astro");
		expect(closure.modules.map((m) => m.path).sort()).toEqual([
			"/src/pages/a.astro",
			"/src/pages/b.astro",
		]);
	});
});

describe("ModuleGraph cache persistence (§7.4 brief)", () => {
	it("survives a Coordinator graph wipe — second compile served from Cache.get", async () => {
		const { host, graph } = makeFixture({
			"/src/pages/index.astro": '---\nimport L from "../components/L.astro";\n---\n<L/>',
			"/src/components/L.astro": "<p>x</p>",
		});

		// Warm the storage cache.
		await graph.closure("/src/pages/index.astro");
		const compilesAfterWarm = host.logger.byName("module-graph.compile").length;
		expect(compilesAfterWarm).toBe(2); // root + L

		// Simulate a "cold" Coordinator: blow away the in-memory graph entirely
		// and use a fresh ModuleGraph instance (so the in-flight Map is also empty).
		await host.coordinator.graphRemove("/src/pages/index.astro");
		await host.coordinator.graphRemove("/src/components/L.astro");
		const graph2 = new ModuleGraph(host, { runtimeImport: RUNTIME_URL });

		await graph2.closure("/src/pages/index.astro");

		// No new "module-graph.compile" events (cache hits served everything).
		const compilesAfterCold = host.logger.byName("module-graph.compile").length;
		expect(compilesAfterCold).toBe(compilesAfterWarm);

		// Two new cache hits (one per module).
		expect(host.logger.byName("module-graph.cache.hit").length).toBe(2);
	});
});
