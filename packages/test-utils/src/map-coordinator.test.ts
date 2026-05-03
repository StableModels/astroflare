import type { HmrMessage, ModuleNode } from "@astroflare/core";
import { describe, expect, it } from "vitest";
import { MapCoordinator } from "./map-coordinator.js";

const node = (path: string, imports: string[] = []): ModuleNode => ({
	path,
	hash: `h:${path}`,
	imports,
	importedBy: [],
});

describe("MapCoordinator graph CRUD", () => {
	it("graphPut + graphGet round-trip", async () => {
		const c = new MapCoordinator();
		await c.graphPut(node("/a"));
		expect((await c.graphGet("/a"))?.path).toBe("/a");
		expect(await c.graphGet("/missing")).toBeNull();
	});

	it("graphPut maintains reverse edges", async () => {
		const c = new MapCoordinator();
		await c.graphPut(node("/b"));
		await c.graphPut(node("/a", ["/b"])); // /a imports /b
		expect((await c.graphGet("/b"))?.importedBy).toEqual(["/a"]);
	});

	it("graphPut updates reverse edges when imports change", async () => {
		const c = new MapCoordinator();
		await c.graphPut(node("/b"));
		await c.graphPut(node("/c"));
		await c.graphPut(node("/a", ["/b"]));
		expect((await c.graphGet("/b"))?.importedBy).toEqual(["/a"]);
		// /a now imports /c instead
		await c.graphPut({ ...node("/a", ["/c"]) });
		expect((await c.graphGet("/b"))?.importedBy).toEqual([]);
		expect((await c.graphGet("/c"))?.importedBy).toEqual(["/a"]);
	});

	it("graphRemove cleans reverse edges and dangling refs", async () => {
		const c = new MapCoordinator();
		await c.graphPut(node("/b"));
		await c.graphPut(node("/a", ["/b"]));
		await c.graphRemove("/b");
		expect(await c.graphGet("/b")).toBeNull();
		// /a's imports should no longer include the removed path
		expect((await c.graphGet("/a"))?.imports).toEqual([]);
	});
});

describe("MapCoordinator pubsub", () => {
	it("publish fans out to all subscribers on a channel", async () => {
		const c = new MapCoordinator();
		const got: HmrMessage[] = [];
		c.subscribe("hmr", (m) => got.push(m));
		c.subscribe("hmr", (m) => got.push(m));
		await c.publish("hmr", { type: "full-reload", reason: "test" });
		expect(got).toHaveLength(2);
	});

	it("unsubscribe stops further deliveries", async () => {
		const c = new MapCoordinator();
		const got: HmrMessage[] = [];
		const sub = c.subscribe("hmr", (m) => got.push(m));
		await c.publish("hmr", { type: "full-reload", reason: "first" });
		sub.unsubscribe();
		await c.publish("hmr", { type: "full-reload", reason: "second" });
		expect(got).toHaveLength(1);
		expect(c.subscriberCount("hmr")).toBe(0);
	});

	it("subscriber exception does not stop fan-out", async () => {
		const c = new MapCoordinator();
		const got: HmrMessage[] = [];
		c.subscribe("hmr", () => {
			throw new Error("boom");
		});
		c.subscribe("hmr", (m) => got.push(m));
		await c.publish("hmr", { type: "full-reload", reason: "x" });
		expect(got).toHaveLength(1);
	});

	it("publishing on an empty channel is a no-op", async () => {
		await expect(
			new MapCoordinator().publish("hmr", { type: "full-reload", reason: "x" }),
		).resolves.toBeUndefined();
	});
});

describe("MapCoordinator onFileChanged", () => {
	it("updates the changed file's hash", async () => {
		const c = new MapCoordinator();
		await c.graphPut(node("/a"));
		await c.onFileChanged("/a", "h2");
		expect((await c.graphGet("/a"))?.hash).toBe("h2");
	});

	it("creates a node if one didn't exist", async () => {
		const c = new MapCoordinator();
		await c.onFileChanged("/new", "h");
		expect((await c.graphGet("/new"))?.hash).toBe("h");
	});

	it("publishes an HMR update including the changed file", async () => {
		const c = new MapCoordinator();
		await c.graphPut(node("/a"));
		const seen: HmrMessage[] = [];
		c.subscribe("hmr", (m) => seen.push(m));
		await c.onFileChanged("/a", "h-new");
		expect(seen).toHaveLength(1);
		const msg = seen[0];
		expect(msg?.type).toBe("update");
		if (msg?.type === "update") {
			expect(msg.updates.map((u) => u.path)).toContain("/a");
		}
	});

	it("invalidation includes every transitively-importing module", async () => {
		// Graph:
		//   /leaf  ← /mid  ← /top
		//   /leaf  ← /sib
		// Changing /leaf must invalidate /leaf, /mid, /top, /sib.
		const c = new MapCoordinator();
		await c.graphPut(node("/leaf"));
		await c.graphPut(node("/sib", ["/leaf"]));
		await c.graphPut(node("/mid", ["/leaf"]));
		await c.graphPut(node("/top", ["/mid"]));

		const seen: HmrMessage[] = [];
		c.subscribe("hmr", (m) => seen.push(m));
		await c.onFileChanged("/leaf", "h-new");

		const msg = seen[0];
		if (msg?.type !== "update") throw new Error("expected update");
		const paths = msg.updates.map((u) => u.path).sort();
		expect(paths).toEqual(["/leaf", "/mid", "/sib", "/top"]);
	});

	it("CSS files get kind:css in the update", async () => {
		const c = new MapCoordinator();
		await c.graphPut(node("/a.css"));
		const seen: HmrMessage[] = [];
		c.subscribe("hmr", (m) => seen.push(m));
		await c.onFileChanged("/a.css", "h");
		const msg = seen[0];
		if (msg?.type !== "update") throw new Error();
		expect(msg.updates[0]?.kind).toBe("css");
	});
});

// ---------------------------------------------------------------------------
// onFileRemoved → prune HMR (Phase 10)
// ---------------------------------------------------------------------------

describe("MapCoordinator onFileRemoved", () => {
	it("removes the node and clears reverse edges", async () => {
		const c = new MapCoordinator();
		await c.graphPut(node("/b"));
		await c.graphPut(node("/a", ["/b"]));
		await c.onFileRemoved("/b");
		expect(await c.graphGet("/b")).toBeNull();
		expect((await c.graphGet("/a"))?.imports).toEqual([]);
	});

	it("publishes a prune message naming the removed path", async () => {
		const c = new MapCoordinator();
		await c.graphPut(node("/p"));
		const seen: HmrMessage[] = [];
		c.subscribe("hmr", (m) => seen.push(m));
		await c.onFileRemoved("/p");
		expect(seen).toHaveLength(1);
		const msg = seen[0];
		expect(msg?.type).toBe("prune");
		if (msg?.type === "prune") {
			expect(msg.paths).toContain("/p");
		}
	});

	it("prune includes every transitively-importing module", async () => {
		// /leaf  ← /mid  ← /top
		const c = new MapCoordinator();
		await c.graphPut(node("/leaf"));
		await c.graphPut(node("/mid", ["/leaf"]));
		await c.graphPut(node("/top", ["/mid"]));

		const seen: HmrMessage[] = [];
		c.subscribe("hmr", (m) => seen.push(m));
		await c.onFileRemoved("/leaf");

		const msg = seen[0];
		if (msg?.type !== "prune") throw new Error("expected prune");
		expect([...msg.paths].sort()).toEqual(["/leaf", "/mid", "/top"]);
	});

	it("removing a file with no graph node still publishes a single-path prune", async () => {
		const c = new MapCoordinator();
		const seen: HmrMessage[] = [];
		c.subscribe("hmr", (m) => seen.push(m));
		await c.onFileRemoved("/never-tracked.astro");
		expect(seen).toHaveLength(1);
		const msg = seen[0];
		if (msg?.type !== "prune") throw new Error("expected prune");
		expect(msg.paths).toEqual(["/never-tracked.astro"]);
	});
});

// ---------------------------------------------------------------------------
// Property test (§Phase 1.c, brief): random graphs + random edits, assert
// every transitively-importing module is in the invalidation set.
// ---------------------------------------------------------------------------

class SeededRandom {
	#state: number;
	constructor(seed: number) {
		this.#state = seed | 0 || 1;
	}
	next(): number {
		// xorshift32
		let x = this.#state;
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		this.#state = x | 0;
		return ((x >>> 0) % 100000) / 100000;
	}
	int(maxExcl: number): number {
		return Math.floor(this.next() * maxExcl);
	}
	pick<T>(arr: readonly T[]): T {
		return arr[this.int(arr.length)] as T;
	}
}

interface RefGraph {
	imports: Map<string, Set<string>>; // path -> direct imports
	importedBy: Map<string, Set<string>>; // path -> direct importers
}

function transitiveImporters(g: RefGraph, root: string): Set<string> {
	const seen = new Set<string>();
	const queue: string[] = [root];
	while (queue.length > 0) {
		const cur = queue.shift() as string;
		const parents = g.importedBy.get(cur) ?? new Set();
		for (const p of parents) {
			if (!seen.has(p)) {
				seen.add(p);
				queue.push(p);
			}
		}
	}
	return seen;
}

function makeRandomGraph(rng: SeededRandom, nodeCount: number): RefGraph {
	const imports = new Map<string, Set<string>>();
	const importedBy = new Map<string, Set<string>>();
	const paths = Array.from({ length: nodeCount }, (_, i) => `/n${i}`);
	for (const p of paths) {
		imports.set(p, new Set());
		importedBy.set(p, new Set());
	}
	// Add edges from later → earlier to guarantee acyclicity.
	for (let i = 1; i < nodeCount; i++) {
		const fanIn = rng.int(Math.min(i, 4));
		for (let k = 0; k < fanIn; k++) {
			const target = rng.int(i); // 0..i-1
			const fromPath = paths[i] as string;
			const toPath = paths[target] as string;
			imports.get(fromPath)?.add(toPath);
			importedBy.get(toPath)?.add(fromPath);
		}
	}
	return { imports, importedBy };
}

describe("MapCoordinator invalidation property tests", () => {
	it("for any random DAG, onFileChanged invalidates every transitive importer", async () => {
		const ITERATIONS = 200;
		for (let seed = 1; seed <= ITERATIONS; seed++) {
			const rng = new SeededRandom(seed);
			const nodeCount = 5 + rng.int(20); // 5..24
			const g = makeRandomGraph(rng, nodeCount);

			const c = new MapCoordinator();
			for (const [path, imports] of g.imports) {
				await c.graphPut({
					path,
					hash: "h0",
					imports: Array.from(imports),
					importedBy: [],
				});
			}

			// Pick a random node to change.
			const paths = Array.from(g.imports.keys());
			const target = rng.pick(paths);

			const seen: HmrMessage[] = [];
			c.subscribe("hmr", (m) => seen.push(m));
			await c.onFileChanged(target, "h-new");

			const msg = seen[0];
			if (msg?.type !== "update") throw new Error(`seed=${seed}: expected update`);
			const got = new Set(msg.updates.map((u) => u.path));

			const expected = transitiveImporters(g, target);
			expected.add(target);

			expect(got, `seed=${seed} target=${target}`).toEqual(expected);
		}
	});
});
