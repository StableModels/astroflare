/**
 * In-memory `Coordinator`.
 *
 * Owns:
 *   - the module graph (a `Map<path, ModuleNode>` with reverse-edge bookkeeping
 *     maintained by `graphPut`/`graphRemove`).
 *   - the change pipeline (`onFileChanged` walks the reverse closure and
 *     publishes a single HMR `update` containing every transitively-affected
 *     module).
 *   - the pubsub bus (`Map<channel, Set<handler>>`).
 *
 * Phase 1c property-tests the invalidation walk against random graphs.
 */
import type {
	Coordinator,
	HmrMessage,
	HmrUpdate,
	ModuleNode,
	Subscription,
} from "@astroflare/core";

export class MapCoordinator implements Coordinator {
	readonly #graph = new Map<string, ModuleNode>();
	readonly #subs = new Map<string, Set<(m: HmrMessage) => void>>();

	async graphGet(path: string): Promise<ModuleNode | null> {
		return this.#graph.get(path) ?? null;
	}

	async graphPut(node: ModuleNode): Promise<void> {
		const prev = this.#graph.get(node.path);
		// Maintain reverse edges: when a node's `imports` changes, the targets'
		// `importedBy` arrays must be updated. `graphPut` is the only mutation
		// path, so this is the right place.
		const oldImports = new Set(prev?.imports ?? []);
		const newImports = new Set(node.imports);

		for (const target of oldImports) {
			if (!newImports.has(target)) this.#removeImportedBy(target, node.path);
		}
		for (const target of newImports) {
			if (!oldImports.has(target)) this.#addImportedBy(target, node.path);
		}

		// The supplied node's `importedBy` is whatever the graph already has
		// (callers don't compute reverse edges; that's our job).
		const stored: ModuleNode = {
			...node,
			importedBy: this.#graph.get(node.path)?.importedBy ?? node.importedBy ?? [],
		};
		this.#graph.set(node.path, stored);
	}

	async graphRemove(path: string): Promise<void> {
		const node = this.#graph.get(path);
		if (!node) return;
		for (const target of node.imports) this.#removeImportedBy(target, path);
		// Other nodes that imported `path` are now broken refs; clear them too.
		for (const importer of node.importedBy) {
			const imp = this.#graph.get(importer);
			if (!imp) continue;
			this.#graph.set(importer, {
				...imp,
				imports: imp.imports.filter((p) => p !== path),
			});
		}
		this.#graph.delete(path);
	}

	async onFileChanged(path: string, hash: string): Promise<void> {
		const node = this.#graph.get(path);
		if (node) {
			this.#graph.set(path, { ...node, hash });
		} else {
			this.#graph.set(path, { path, hash, imports: [], importedBy: [] });
		}
		const invalidated = this.#transitiveImporters(path);
		invalidated.add(path);
		const updates: HmrUpdate[] = Array.from(invalidated).map((p) => ({
			path: p,
			hash: this.#graph.get(p)?.hash ?? hash,
			kind: p.endsWith(".css") ? "css" : "module",
		}));
		await this.publish("hmr", { type: "update", trigger: path, updates });
	}

	async publish(channel: string, message: HmrMessage): Promise<void> {
		const handlers = this.#subs.get(channel);
		if (!handlers) return;
		// Snapshot to avoid mutation during iteration.
		for (const h of Array.from(handlers)) {
			try {
				h(message);
			} catch {
				// Subscribers must not throw upstream; swallow to keep fan-out
				// going. Tests can use a custom logger if they want to observe.
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
				set.delete(handler);
				if (set.size === 0) this.#subs.delete(channel);
			},
		};
	}

	// --- test affordances ---

	/** Snapshot all graph nodes, sorted for stable assertions. */
	graphSnapshot(): readonly ModuleNode[] {
		return Array.from(this.#graph.values()).sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Number of subscribers on a channel. */
	subscriberCount(channel: string): number {
		return this.#subs.get(channel)?.size ?? 0;
	}

	// --- internals ---

	#transitiveImporters(path: string): Set<string> {
		const seen = new Set<string>();
		const queue: string[] = [path];
		while (queue.length > 0) {
			const cur = queue.shift() as string;
			const node = this.#graph.get(cur);
			if (!node) continue;
			for (const importer of node.importedBy) {
				if (!seen.has(importer)) {
					seen.add(importer);
					queue.push(importer);
				}
			}
		}
		return seen;
	}

	#addImportedBy(targetPath: string, importer: string): void {
		const target = this.#graph.get(targetPath);
		if (!target) {
			this.#graph.set(targetPath, {
				path: targetPath,
				hash: "",
				imports: [],
				importedBy: [importer],
			});
			return;
		}
		if (target.importedBy.includes(importer)) return;
		this.#graph.set(targetPath, {
			...target,
			importedBy: [...target.importedBy, importer],
		});
	}

	#removeImportedBy(targetPath: string, importer: string): void {
		const target = this.#graph.get(targetPath);
		if (!target) return;
		this.#graph.set(targetPath, {
			...target,
			importedBy: target.importedBy.filter((p) => p !== importer),
		});
	}
}
