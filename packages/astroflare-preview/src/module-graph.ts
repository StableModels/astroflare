import type { ModuleNode } from "@astroflare/core";

/**
 * In-memory module graph used by the preview server.
 *
 * Responsibilities:
 *   - Maintain `node.deps` (declared by the compiler) and `node.importers` (the
 *     reverse index, computed here).
 *   - Compute the transitive importer closure for an invalidated path.
 *
 * Cycles are tolerated. ESM technically forbids cyclic top-level resolution
 * loops but the *graph* can be cyclic via re-imports; the BFS in
 * `invalidate()` is cycle-safe.
 */
export class ModuleGraph {
  private readonly nodes = new Map<string, ModuleNode>();

  has(path: string): boolean {
    return this.nodes.has(path);
  }

  get(path: string): ModuleNode | undefined {
    const n = this.nodes.get(path);
    if (!n) return undefined;
    return cloneNode(n);
  }

  paths(): IterableIterator<string> {
    return this.nodes.keys();
  }

  /**
   * Insert or update a node. `importers` is recomputed automatically; callers
   * should not pass it.
   *
   * Nodes referenced as deps but not yet compiled are kept as placeholders
   * (hash=""). When an importer drops a dep, an orphaned placeholder (no live
   * importers and never compiled) is GC'd so the node set always matches
   * "explicitly compiled paths ∪ paths referenced by some live deps array".
   */
  set(path: string, hash: string, deps: readonly string[]): void {
    const previous = this.nodes.get(path);
    const dedupedDeps = uniq(deps);

    if (previous) {
      for (const d of previous.deps) {
        if (dedupedDeps.includes(d)) continue;
        this.removeImporter(d, path);
      }
    }

    const node: ModuleNode = {
      path,
      hash,
      deps: dedupedDeps.slice(),
      importers: previous ? previous.importers.slice() : [],
    };
    this.nodes.set(path, node);

    for (const d of dedupedDeps) {
      let depNode = this.nodes.get(d);
      if (!depNode) {
        depNode = { path: d, hash: "", deps: [], importers: [] };
        this.nodes.set(d, depNode);
      }
      if (!depNode.importers.includes(path)) depNode.importers.push(path);
    }
  }

  /**
   * Remove a node from the graph.
   *
   * If anyone still imports it, the node is tombstoned (deps cleared, hash
   * cleared) so importer back-edges remain intact — a subsequent `invalidate`
   * for the deleted path will still report the importers, which is what we
   * want: their compilation has been broken by the deletion and they need to
   * be recompiled (and may then surface a "module not found" error).
   *
   * If no one imports it, it is fully removed.
   */
  delete(path: string): void {
    const node = this.nodes.get(path);
    if (!node) return;
    for (const d of node.deps) {
      this.removeImporter(d, path);
    }
    if (node.importers.length > 0) {
      node.deps = [];
      node.hash = "";
    } else {
      this.nodes.delete(path);
    }
  }

  private removeImporter(depPath: string, importerPath: string): void {
    const dep = this.nodes.get(depPath);
    if (!dep) return;
    dep.importers = dep.importers.filter((p) => p !== importerPath);
    // GC: an uncompiled placeholder with no remaining importers is unreachable.
    if (dep.importers.length === 0 && dep.hash === "" && dep.deps.length === 0) {
      this.nodes.delete(depPath);
    }
  }

  /**
   * Return the set of paths that must be invalidated when `path` changes.
   *
   * The set is the transitive closure of importers, INCLUDING `path` itself.
   * If `path` is not in the graph, returns an empty set.
   */
  invalidate(path: string): Set<string> {
    const out = new Set<string>();
    if (!this.nodes.has(path)) return out;
    const queue: string[] = [path];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      if (out.has(next)) continue;
      out.add(next);
      const node = this.nodes.get(next);
      if (!node) continue;
      for (const importer of node.importers) {
        if (!out.has(importer)) queue.push(importer);
      }
    }
    return out;
  }

  /**
   * Internal-consistency check used by tests.
   *
   * Returns the empty array on a sound graph; otherwise an array of human-readable
   * problems. A graph is sound when every edge in `deps` has a matching entry in
   * the target's `importers`, and vice versa, and no node lists itself.
   */
  audit(): string[] {
    const problems: string[] = [];
    for (const node of this.nodes.values()) {
      const seenDeps = new Set<string>();
      for (const d of node.deps) {
        if (seenDeps.has(d)) problems.push(`${node.path} lists dep ${d} twice`);
        seenDeps.add(d);
        if (d === node.path) problems.push(`${node.path} lists itself in deps`);
        const dep = this.nodes.get(d);
        if (!dep) {
          problems.push(`${node.path} -> ${d}: dep node missing`);
          continue;
        }
        if (!dep.importers.includes(node.path)) {
          problems.push(`${node.path} -> ${d}: importer back-edge missing`);
        }
      }
      const seenImps = new Set<string>();
      for (const i of node.importers) {
        if (seenImps.has(i)) problems.push(`${node.path} lists importer ${i} twice`);
        seenImps.add(i);
        const imp = this.nodes.get(i);
        if (!imp) {
          problems.push(`${node.path} <- ${i}: importer node missing`);
          continue;
        }
        if (!imp.deps.includes(node.path)) {
          problems.push(`${node.path} <- ${i}: forward edge missing`);
        }
      }
    }
    return problems;
  }

  size(): number {
    return this.nodes.size;
  }

  clear(): void {
    this.nodes.clear();
  }
}

function cloneNode(n: ModuleNode): ModuleNode {
  return {
    path: n.path,
    hash: n.hash,
    deps: n.deps.slice(),
    importers: n.importers.slice(),
  };
}

function uniq<T>(arr: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
