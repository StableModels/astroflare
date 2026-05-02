import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../src/memory-storage.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("MemoryStorage", () => {
  it("round-trips bytes through read/write", async () => {
    const s = new MemoryStorage();
    await s.write("foo.txt", enc.encode("hello"));
    const out = await s.read("foo.txt");
    expect(dec.decode(out)).toBe("hello");
  });

  it("normalizes ./ leading paths", async () => {
    const s = new MemoryStorage();
    await s.write("./foo.txt", enc.encode("a"));
    expect(dec.decode(await s.read("foo.txt"))).toBe("a");
  });

  it("read of missing path throws ENOENT", async () => {
    const s = new MemoryStorage();
    await expect(s.read("missing")).rejects.toThrow(/ENOENT/);
  });

  it("stat returns null for missing, FileStat with hash otherwise", async () => {
    const s = new MemoryStorage();
    expect(await s.stat("nope")).toBeNull();
    await s.write("a", enc.encode("hi"));
    const stat = await s.stat("a");
    expect(stat).toMatchObject({ size: 2 });
    expect(stat!.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("stat hash is stable for identical content and differs for different content", async () => {
    const s = new MemoryStorage();
    await s.write("a", enc.encode("xx"));
    await s.write("b", enc.encode("xx"));
    await s.write("c", enc.encode("yy"));
    const a = await s.stat("a");
    const b = await s.stat("b");
    const c = await s.stat("c");
    expect(a!.hash).toBe(b!.hash);
    expect(a!.hash).not.toBe(c!.hash);
  });

  it("cache subspace is isolated from file subspace", async () => {
    const s = new MemoryStorage();
    await s.write("foo", enc.encode("file"));
    await s.cacheWrite("foo", enc.encode("cache"));
    expect(dec.decode(await s.read("foo"))).toBe("file");
    expect(dec.decode((await s.cacheRead("foo"))!)).toBe("cache");
    // a hash that doesn't exist in the cache returns null
    expect(await s.cacheRead("absent")).toBeNull();
  });

  it("glob matches *, **, and {a,b} patterns", async () => {
    const s = new MemoryStorage();
    s.writeSync("src/pages/index.astro", "");
    s.writeSync("src/pages/about.astro", "");
    s.writeSync("src/pages/blog/post.md", "");
    s.writeSync("src/pages/blog/draft.mdx", "");
    s.writeSync("src/components/Foo.astro", "");
    s.writeSync("public/logo.png", "");

    expect(await collect(s.glob("src/pages/*.astro"))).toEqual([
      "src/pages/about.astro",
      "src/pages/index.astro",
    ]);
    expect(await collect(s.glob("src/pages/**"))).toEqual([
      "src/pages/about.astro",
      "src/pages/blog/draft.mdx",
      "src/pages/blog/post.md",
      "src/pages/index.astro",
    ]);
    expect(await collect(s.glob("src/pages/**/*.{md,mdx}"))).toEqual([
      "src/pages/blog/draft.mdx",
      "src/pages/blog/post.md",
    ]);
    expect(await collect(s.glob("**/*.astro"))).toEqual([
      "src/components/Foo.astro",
      "src/pages/about.astro",
      "src/pages/index.astro",
    ]);
  });
});
