import { ModuleGraph } from "@astroflare/preview/module-graph";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Reference implementation: the spec the optimised graph must match.
// ---------------------------------------------------------------------------

interface Spec {
  /** path -> dep paths, in declaration order. */
  deps: Map<string, string[]>;
}

function specImporters(spec: Spec, target: string): string[] {
  const out: string[] = [];
  for (const [p, ds] of spec.deps) {
    if (ds.includes(target)) out.push(p);
  }
  out.sort();
  return out;
}

/** Closure of all paths that transitively import `target`, BFS via reverse edges. */
function specInvalidate(spec: Spec, target: string): Set<string> {
  if (!spec.deps.has(target) && !specHasAnyDepOn(spec, target)) return new Set();
  const out = new Set<string>([target]);
  const queue = [target];
  while (queue.length > 0) {
    const next = queue.shift()!;
    for (const p of specImporters(spec, next)) {
      if (!out.has(p)) {
        out.add(p);
        queue.push(p);
      }
    }
  }
  return out;
}

function specHasAnyDepOn(spec: Spec, target: string): boolean {
  for (const ds of spec.deps.values()) if (ds.includes(target)) return true;
  return false;
}

// Unit examples --------------------------------------------------------------

describe("ModuleGraph (unit)", () => {
  it("set/get round-trips a node and indexes importers in reverse", () => {
    const g = new ModuleGraph();
    g.set("a", "h1", ["b", "c"]);
    g.set("b", "h2", []);
    g.set("c", "h3", []);
    expect(g.get("b")!.importers).toEqual(["a"]);
    expect(g.get("c")!.importers).toEqual(["a"]);
    expect(g.audit()).toEqual([]);
  });

  it("re-setting a node with different deps cleans up stale back-edges", () => {
    const g = new ModuleGraph();
    g.set("a", "h1", ["b", "c"]);
    g.set("b", "hb", []);
    g.set("c", "hc", []);
    expect(g.get("b")!.importers).toEqual(["a"]);

    g.set("a", "h2", ["c"]); // no longer imports b
    expect(g.get("b")!.importers).toEqual([]);
    expect(g.get("c")!.importers).toEqual(["a"]);
    expect(g.audit()).toEqual([]);
  });

  it("invalidate returns the transitive importer closure including the seed", () => {
    const g = new ModuleGraph();
    g.set("page", "hp", ["layout"]);
    g.set("layout", "hl", ["component"]);
    g.set("component", "hc", []);
    expect([...g.invalidate("component")].sort()).toEqual(["component", "layout", "page"]);
    expect([...g.invalidate("layout")].sort()).toEqual(["layout", "page"]);
    expect([...g.invalidate("page")]).toEqual(["page"]);
  });

  it("invalidate of an unknown path returns an empty set", () => {
    const g = new ModuleGraph();
    g.set("a", "h", []);
    expect([...g.invalidate("missing")]).toEqual([]);
  });

  it("invalidate is cycle-safe", () => {
    const g = new ModuleGraph();
    g.set("a", "h", ["b"]);
    g.set("b", "h", ["a"]);
    expect([...g.invalidate("a")].sort()).toEqual(["a", "b"]);
    expect([...g.invalidate("b")].sort()).toEqual(["a", "b"]);
  });

  it("delete removes node and cleans back-edges", () => {
    const g = new ModuleGraph();
    g.set("a", "h", ["b"]);
    g.set("b", "h", []);
    g.delete("a");
    expect(g.get("a")).toBeUndefined();
    expect(g.get("b")!.importers).toEqual([]);
    expect(g.audit()).toEqual([]);
  });
});

// Property tests -------------------------------------------------------------

/**
 * Generate a random graph as: N labelled nodes plus, for each node, a random
 * subset of OTHER nodes as deps (allowing cycles). Then a random sequence of
 * edits: add-node, remove-node, mutate-deps, change-hash. After each edit,
 * the graph must remain sound (audit clean) and `invalidate` for a random
 * target must equal the spec.
 */

interface Edit {
  kind: "set" | "delete";
  path: string;
  hash?: string;
  deps?: string[];
}

function applyEdit(spec: Spec, edit: Edit): void {
  if (edit.kind === "set") {
    spec.deps.set(edit.path, [...(edit.deps ?? [])]);
  } else {
    spec.deps.delete(edit.path);
    // Note: spec doesn't track hashes, only adjacency. Other nodes' deps that
    // reference the deleted path are kept (matches ModuleGraph.delete behavior).
  }
}

function applyToGraph(g: ModuleGraph, edit: Edit): void {
  if (edit.kind === "set") g.set(edit.path, edit.hash ?? "h", edit.deps ?? []);
  else g.delete(edit.path);
}

const labelArb = fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h");

const setEditArb = fc.record({
  kind: fc.constant<"set">("set"),
  path: labelArb,
  hash: fc.string({ minLength: 1, maxLength: 4 }),
  deps: fc.uniqueArray(labelArb, { maxLength: 6 }),
});

const deleteEditArb = fc.record({
  kind: fc.constant<"delete">("delete"),
  path: labelArb,
});

const editArb = fc.oneof(
  { weight: 4, arbitrary: setEditArb },
  { weight: 1, arbitrary: deleteEditArb },
);

describe("ModuleGraph (property)", () => {
  it("after every edit, audit() reports zero problems", () => {
    fc.assert(
      fc.property(fc.array(editArb, { minLength: 1, maxLength: 60 }), (edits) => {
        // Filter self-loops out — both spec and graph treat them as invalid.
        const cleaned = edits.map((e) =>
          e.kind === "set" ? { ...e, deps: e.deps.filter((d) => d !== e.path) } : e,
        );
        const g = new ModuleGraph();
        const spec: Spec = { deps: new Map() };
        for (const e of cleaned) {
          applyEdit(spec, e);
          applyToGraph(g, e);
          expect(g.audit()).toEqual([]);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("invalidate(target) equals the reverse-edge BFS over the spec, for every target after every edit", () => {
    fc.assert(
      fc.property(fc.array(editArb, { minLength: 1, maxLength: 40 }), labelArb, (edits, target) => {
        const cleaned = edits.map((e) =>
          e.kind === "set" ? { ...e, deps: e.deps.filter((d) => d !== e.path) } : e,
        );
        const g = new ModuleGraph();
        const spec: Spec = { deps: new Map() };
        for (const e of cleaned) {
          applyEdit(spec, e);
          applyToGraph(g, e);
        }
        // Skip oracles where the target was never present in either model
        // (both should return empty; this is asserted below).
        const expected = computeExpectedInvalidation(spec, target);
        const actual = new Set(g.invalidate(target));
        expect([...actual].sort()).toEqual([...expected].sort());
      }),
      { numRuns: 200 },
    );
  });

  it("a hash bump on a leaf produces an invalidation set of {leaf}", () => {
    fc.assert(
      fc.property(labelArb, fc.string({ minLength: 1, maxLength: 4 }), (path, h) => {
        const g = new ModuleGraph();
        g.set(path, h, []);
        expect([...g.invalidate(path)]).toEqual([path]);
      }),
    );
  });

  it("every reachable importer of a changed module appears in the invalidation set", () => {
    fc.assert(
      fc.property(fc.array(editArb, { minLength: 5, maxLength: 30 }), labelArb, (edits, target) => {
        const cleaned = edits.map((e) =>
          e.kind === "set" ? { ...e, deps: e.deps.filter((d) => d !== e.path) } : e,
        );
        const g = new ModuleGraph();
        for (const e of cleaned) applyToGraph(g, e);

        const inv = g.invalidate(target);
        // Soundness: nothing in the invalidation set is missing from the graph
        // (every entry is a real, reachable node).
        for (const p of inv) {
          expect(g.get(p)).not.toBeUndefined();
        }
        // Completeness on direct importers: any node whose deps include `target`
        // and which is itself in the graph must be in the invalidation set.
        for (const path of g.paths()) {
          const node = g.get(path)!;
          if (node.deps.includes(target)) {
            expect(inv.has(path)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * The graph reports nodes for any path mentioned by a `set` edit, including
 * placeholder nodes for not-yet-declared deps. The spec's `deps` map only
 * contains paths that have been explicitly `set`. Bring them into alignment
 * before comparing invalidation closures.
 */
function computeExpectedInvalidation(spec: Spec, target: string): Set<string> {
  // Collect every path the graph would know about: explicit nodes + placeholder
  // dep references.
  const known = new Set<string>(spec.deps.keys());
  for (const ds of spec.deps.values()) for (const d of ds) known.add(d);
  if (!known.has(target)) return new Set();
  return specInvalidate(spec, target);
}
