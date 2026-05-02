import type { HmrMessage } from "@astroflare/core";
import { describe, expect, it } from "vitest";
import { MapCoordinator } from "../src/map-coordinator.js";

describe("MapCoordinator", () => {
  it("graphPut/graphGet round-trip", async () => {
    const c = new MapCoordinator();
    await c.graphPut({
      path: "src/pages/index.astro",
      hash: "abc123",
      deps: ["src/components/Foo.astro"],
      importers: [], // ignored — coordinator computes this
    });
    const out = await c.graphGet("src/pages/index.astro");
    expect(out).not.toBeNull();
    expect(out!.hash).toBe("abc123");
    expect(out!.deps).toEqual(["src/components/Foo.astro"]);
  });

  it("graphGet returns null for unknown path", async () => {
    const c = new MapCoordinator();
    expect(await c.graphGet("missing")).toBeNull();
  });

  it("publish fans out to all matching subscribers, but not other channels", async () => {
    const c = new MapCoordinator();
    const hmr: HmrMessage[] = [];
    const other: HmrMessage[] = [];
    c.subscribe("hmr", (m) => hmr.push(m));
    c.subscribe("hmr", (m) => hmr.push(m));
    c.subscribe("other", (m) => other.push(m));

    const msg: HmrMessage = { type: "full-reload", reason: "x" };
    await c.publish("hmr", msg);
    expect(hmr).toEqual([msg, msg]);
    expect(other).toEqual([]);
  });

  it("subscribe returns a working unsubscribe", async () => {
    const c = new MapCoordinator();
    const seen: HmrMessage[] = [];
    const sub = c.subscribe("hmr", (m) => seen.push(m));
    await c.publish("hmr", { type: "full-reload", reason: "1" });
    sub.unsubscribe();
    await c.publish("hmr", { type: "full-reload", reason: "2" });
    expect(seen).toEqual([{ type: "full-reload", reason: "1" }]);
    expect(c.subscriberCount("hmr")).toBe(0);
  });

  it("onFileChanged updates hash, preserves deps, and broadcasts an update", async () => {
    const c = new MapCoordinator();
    await c.graphPut({
      path: "a",
      hash: "h1",
      deps: ["b"],
      importers: [],
    });
    await c.graphPut({
      path: "b",
      hash: "hb",
      deps: [],
      importers: [],
    });

    const seen: HmrMessage[] = [];
    c.subscribe("hmr", (m) => seen.push(m));

    await c.onFileChanged("a", "h2");
    const a = await c.graphGet("a");
    expect(a!.hash).toBe("h2");
    expect(a!.deps).toEqual(["b"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: "update",
      path: "a",
      hash: "h2",
    });
  });

  it("onFileChanged for a leaf node yields a single-path acceptedBy set", async () => {
    const c = new MapCoordinator();
    await c.graphPut({ path: "leaf", hash: "h", deps: [], importers: [] });
    let captured: HmrMessage | null = null;
    c.subscribe("hmr", (m) => {
      captured = m;
    });
    await c.onFileChanged("leaf", "h2");
    expect(captured).not.toBeNull();
    const update = captured as unknown as Extract<HmrMessage, { type: "update" }>;
    expect(update.acceptedBy).toEqual(["leaf"]);
  });

  it("onFileChanged for a deeply-imported module names every transitive importer", async () => {
    const c = new MapCoordinator();
    // page -> layout -> component
    await c.graphPut({ path: "component", hash: "hc", deps: [], importers: [] });
    await c.graphPut({ path: "layout", hash: "hl", deps: ["component"], importers: [] });
    await c.graphPut({ path: "page", hash: "hp", deps: ["layout"], importers: [] });

    let captured: HmrMessage | null = null;
    c.subscribe("hmr", (m) => {
      captured = m;
    });
    await c.onFileChanged("component", "hc2");
    const update = captured as unknown as Extract<HmrMessage, { type: "update" }>;
    expect(update.acceptedBy.sort()).toEqual(["component", "layout", "page"]);
  });
});
