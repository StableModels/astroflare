/**
 * `CoordinatorDurableObject` — production-shaped persistent module graph.
 *
 * The framework's `Coordinator` interface (§5.2 of the brief) owns three
 * things: the module graph, the change pipeline, and the pubsub bus.
 * Phase 15 splits them across the Worker boundary:
 *
 *   - **module graph** lives inside this DO (`ctx.storage`-backed, sqlite
 *     under the hood). One DO per workspace, keyed by
 *     `idFromName(workspaceId)`.
 *   - **change pipeline** + **pubsub bus** live in the Worker isolate via
 *     `DurableObjectCoordinator` (this file's wrapper class). Pubsub
 *     handlers are JS callbacks — they can't survive RPC, so subscribers
 *     stay local to the Worker that called `subscribe`.
 *
 * Cross-Worker fan-out for HMR is the Transport's job, not the
 * Coordinator's: the project worker calls `coordinator.subscribe("hmr",
 * msg => transport.broadcastHmr(workspaceId, msg))` once per request, and
 * the Transport DO (Phase 5) handles WebSocket fan-out across every
 * worker instance with a connected client.
 *
 * Persistence: nodes survive DO eviction. After a cold start the first
 * `graphGet` is served from sqlite; the Storage compile cache (also R2-
 * backed) means even total state loss recovers cheaply (§7.4 of the brief).
 *
 * Phase 15 carve-outs:
 *   - The DO doesn't proactively notify subscribers when state changes
 *     across Worker boundaries. Subscribers see only events published
 *     in their own Worker. The Transport's WS DO fills this role for
 *     HMR; other channels (log streaming, deploy progress) would need
 *     their own DO if they want cross-Worker fan-out.
 *   - No bulk `graphSnapshot()` RPC. Walks happen via repeated
 *     `graphGet`; transitive closures use the dedicated
 *     `transitiveImporters()` RPC so the round-trip count stays linear
 *     in closure size, not depth.
 */

import { DurableObject } from "cloudflare:workers";
import type {
	Coordinator,
	HmrMessage,
	HmrUpdate,
	ModuleNode,
	Subscription,
} from "@astroflare/core";

const NODE_PREFIX = "node:";

/**
 * The DO class. Module graph lives in `ctx.storage` keyed by
 * `node:<path>`; reverse edges (`importedBy`) are maintained in step
 * with `imports` writes so transitive walks stay cheap.
 */
export class CoordinatorDurableObject extends DurableObject {
	async graphGet(path: string): Promise<ModuleNode | null> {
		const stored = await this.ctx.storage.get<ModuleNode>(`${NODE_PREFIX}${path}`);
		return stored ?? null;
	}

	async graphPut(node: ModuleNode): Promise<void> {
		// Reverse-edge bookkeeping mirrors `MapCoordinator`'s — when the
		// `imports` set diverges from the previous version, the targets'
		// `importedBy` arrays are kept in sync. `graphPut` is the only
		// mutation path that adds edges, so this is the right place.
		const prev = await this.ctx.storage.get<ModuleNode>(`${NODE_PREFIX}${node.path}`);
		const oldImports = new Set(prev?.imports ?? []);
		const newImports = new Set(node.imports);

		for (const target of oldImports) {
			if (!newImports.has(target)) await this.#removeImportedBy(target, node.path);
		}
		for (const target of newImports) {
			if (!oldImports.has(target)) await this.#addImportedBy(target, node.path);
		}

		// Don't trust the supplied `importedBy` — that's our internal
		// bookkeeping, not the caller's. Fall back to whatever was stored
		// (which the prev->add/remove dance just updated).
		const refreshed = await this.ctx.storage.get<ModuleNode>(`${NODE_PREFIX}${node.path}`);
		const stored: ModuleNode = {
			...node,
			importedBy: refreshed?.importedBy ?? node.importedBy ?? [],
		};
		await this.ctx.storage.put(`${NODE_PREFIX}${node.path}`, stored);
	}

	async graphRemove(path: string): Promise<void> {
		const node = await this.ctx.storage.get<ModuleNode>(`${NODE_PREFIX}${path}`);
		if (!node) return;
		// Other nodes' reverse edges that pointed at us — update them.
		for (const target of node.imports) {
			await this.#removeImportedBy(target, path);
		}
		// Other nodes that imported `path` are now broken refs; clear them.
		for (const importer of node.importedBy) {
			const imp = await this.ctx.storage.get<ModuleNode>(`${NODE_PREFIX}${importer}`);
			if (!imp) continue;
			await this.ctx.storage.put(`${NODE_PREFIX}${importer}`, {
				...imp,
				imports: imp.imports.filter((p) => p !== path),
			});
		}
		await this.ctx.storage.delete(`${NODE_PREFIX}${path}`);
	}

	/**
	 * BFS the reverse-edge closure from `path`. Done inside the DO so the
	 * caller sees a single round-trip for the whole walk; otherwise each
	 * level of importers would cost an extra RPC.
	 */
	async transitiveImporters(path: string): Promise<readonly string[]> {
		const seen = new Set<string>();
		const queue: string[] = [path];
		while (queue.length > 0) {
			const cur = queue.shift() as string;
			const node = await this.ctx.storage.get<ModuleNode>(`${NODE_PREFIX}${cur}`);
			if (!node) continue;
			for (const importer of node.importedBy) {
				if (!seen.has(importer)) {
					seen.add(importer);
					queue.push(importer);
				}
			}
		}
		return Array.from(seen);
	}

	/**
	 * Test affordance: snapshot every graph node. Not on `Coordinator`'s
	 * public surface — used only by the host's tests to verify
	 * persistence across stub re-creation.
	 */
	async graphList(): Promise<readonly ModuleNode[]> {
		const all = await this.ctx.storage.list<ModuleNode>({ prefix: NODE_PREFIX });
		return Array.from(all.values()).sort((a, b) => a.path.localeCompare(b.path));
	}

	async #addImportedBy(targetPath: string, importer: string): Promise<void> {
		const target = await this.ctx.storage.get<ModuleNode>(`${NODE_PREFIX}${targetPath}`);
		if (!target) {
			await this.ctx.storage.put(`${NODE_PREFIX}${targetPath}`, {
				path: targetPath,
				hash: "",
				imports: [],
				importedBy: [importer],
			});
			return;
		}
		if (target.importedBy.includes(importer)) return;
		await this.ctx.storage.put(`${NODE_PREFIX}${targetPath}`, {
			...target,
			importedBy: [...target.importedBy, importer],
		});
	}

	async #removeImportedBy(targetPath: string, importer: string): Promise<void> {
		const target = await this.ctx.storage.get<ModuleNode>(`${NODE_PREFIX}${targetPath}`);
		if (!target) return;
		await this.ctx.storage.put(`${NODE_PREFIX}${targetPath}`, {
			...target,
			importedBy: target.importedBy.filter((p) => p !== importer),
		});
	}
}

/**
 * Worker-side wrapper that implements the framework's `Coordinator`
 * interface. Forwards graph operations to the DO via RPC; keeps pubsub
 * local to the Worker isolate (handler functions can't cross RPC).
 *
 * Two subscribers per request is the typical pattern: the preview
 * server's HMR forwarder + the route invalidator. Both run inside the
 * same Worker invocation, so local pubsub is sufficient.
 */
/**
 * Factory that returns a fresh DO stub each call. Needed because workerd
 * invalidates stubs when watched code changes (test cold-starts hit this
 * routinely); retrying with the same stub re-throws the same error,
 * whereas the next `namespace.get(id)` returns a stub backed by the
 * freshly-loaded worker module.
 */
export type CoordinatorStubFactory = () => DurableObjectStub<CoordinatorDurableObject>;

export class DurableObjectCoordinator implements Coordinator {
	readonly #stubFactory: CoordinatorStubFactory;
	readonly #subs = new Map<string, Set<(m: HmrMessage) => void>>();

	constructor(stub: DurableObjectStub<CoordinatorDurableObject> | CoordinatorStubFactory) {
		// Accept either a captured stub (the convenient form for tests) or
		// a factory (the production form, so retries get a fresh stub).
		this.#stubFactory = typeof stub === "function" ? (stub as CoordinatorStubFactory) : () => stub;
	}

	async graphGet(path: string): Promise<ModuleNode | null> {
		return retryOnInvalidation(() => this.#stubFactory().graphGet(path));
	}

	async graphPut(node: ModuleNode): Promise<void> {
		return retryOnInvalidation(() => this.#stubFactory().graphPut(node));
	}

	async graphRemove(path: string): Promise<void> {
		return retryOnInvalidation(() => this.#stubFactory().graphRemove(path));
	}

	async onFileChanged(path: string, hash: string): Promise<void> {
		const existing = await retryOnInvalidation(() => this.#stubFactory().graphGet(path));
		if (existing) {
			await retryOnInvalidation(() => this.#stubFactory().graphPut({ ...existing, hash }));
		} else {
			await retryOnInvalidation(() =>
				this.#stubFactory().graphPut({ path, hash, imports: [], importedBy: [] }),
			);
		}
		const importers = await retryOnInvalidation(() =>
			this.#stubFactory().transitiveImporters(path),
		);
		const updates: HmrUpdate[] = [path, ...importers].map((p) => ({
			path: p,
			hash: p === path ? hash : "",
			kind: p.endsWith(".css") ? "css" : "module",
		}));
		await this.publish("hmr", { type: "update", trigger: path, updates });
	}

	async onFileRemoved(path: string): Promise<void> {
		const importers = await retryOnInvalidation(() =>
			this.#stubFactory().transitiveImporters(path),
		);
		await retryOnInvalidation(() => this.#stubFactory().graphRemove(path));
		await this.publish("hmr", { type: "prune", paths: [path, ...importers] });
	}

	async publish(channel: string, message: HmrMessage): Promise<void> {
		const handlers = this.#subs.get(channel);
		if (!handlers) return;
		// Snapshot to avoid mutation during iteration.
		for (const h of Array.from(handlers)) {
			try {
				h(message);
			} catch {
				// Subscribers must not throw upstream; swallow.
			}
		}
	}

	subscribe(channel: string, handler: (m: HmrMessage) => void): Subscription {
		let set = this.#subs.get(channel);
		if (!set) {
			set = new Set();
			this.#subs.set(channel, set);
		}
		set.add(handler);
		return {
			unsubscribe: () => {
				set?.delete(handler);
				if (set && set.size === 0) this.#subs.delete(channel);
			},
		};
	}
}

/**
 * Workerd may invalidate a Durable Object mid-flight when watched code
 * changes — common during dev / test cold-starts. The thrown error
 * explicitly says "Please retry the DurableObjectStub#fetch() call."
 * `transport.ts` honours that contract for HMR fan-out; this helper
 * does the same for graph RPCs.
 */
async function retryOnInvalidation<R>(op: () => Promise<R>): Promise<R> {
	const maxAttempts = 5;
	let lastErr: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			return await op();
		} catch (err) {
			lastErr = err;
			if (!isInvalidatedDoError(err)) throw err;
		}
	}
	throw lastErr;
}

function isInvalidatedDoError(err: unknown): boolean {
	if (err instanceof Error) {
		return /invalidating this Durable Object|broken\.inputGateBroken/i.test(err.message);
	}
	return false;
}
