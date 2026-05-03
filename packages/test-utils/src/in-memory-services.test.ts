import { describe, expect, it, vi } from "vitest";
import { InMemoryEnvService, InMemoryFsService, InMemoryLogService } from "./in-memory-services.js";
import { MemorySite } from "./memory-site.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("InMemoryFsService", () => {
	it("write / read round-trips through the underlying Storage", async () => {
		const site = new MemorySite();
		const fs = new InMemoryFsService({ site });
		await fs.write("/src/index.astro", enc("<p>hi</p>"));
		const bytes = await fs.read("/src/index.astro");
		expect(bytes).not.toBeNull();
		expect(dec(bytes as Uint8Array)).toBe("<p>hi</p>");
	});

	it("read returns null when the file does not exist", async () => {
		const site = new MemorySite();
		const fs = new InMemoryFsService({ site });
		expect(await fs.read("/nope")).toBeNull();
	});

	it("write fires onWrite with the content hash", async () => {
		const site = new MemorySite();
		const onWrite = vi.fn();
		const fs = new InMemoryFsService({ site, onWrite });
		await fs.write("/x.txt", enc("hello"));
		expect(onWrite).toHaveBeenCalledOnce();
		const call = onWrite.mock.calls[0];
		if (!call) throw new Error("expected onWrite call");
		const [path, hash] = call;
		expect(path).toBe("/x.txt");
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("remove fires onRemove and the file becomes unstat-able", async () => {
		const site = new MemorySite();
		const onRemove = vi.fn();
		const fs = new InMemoryFsService({ site, onRemove });
		await fs.write("/a", enc("1"));
		await fs.remove("/a");
		expect(onRemove).toHaveBeenCalledWith("/a");
		expect(await fs.stat("/a")).toBeNull();
	});

	it("stat returns size + hash", async () => {
		const site = new MemorySite();
		const fs = new InMemoryFsService({ site });
		await fs.write("/x", enc("abcd"));
		const s = await fs.stat("/x");
		expect(s?.size).toBe(4);
		// `Site.statFile` returns the 16-char content-addressed id, not a full
		// SHA-256 — the framework convention from `@astroflare/core`.
		expect(s?.hash).toMatch(/^[a-f0-9]{16}$/);
	});
});

describe("InMemoryLogService", () => {
	it("captures every event with name + fields + timestamp", async () => {
		const log = new InMemoryLogService({ now: () => 1000 });
		await log.event("start", { ms: 1 });
		await log.event("done", { ok: true });
		expect(log.events).toHaveLength(2);
		expect(log.events[0]).toEqual({ name: "start", fields: { ms: 1 }, at: 1000 });
		expect(log.events[1]?.name).toBe("done");
	});

	it("clear() empties the buffer", async () => {
		const log = new InMemoryLogService();
		await log.event("x", {});
		log.clear();
		expect(log.events).toEqual([]);
	});
});

describe("InMemoryEnvService", () => {
	it("returns the secret when present", async () => {
		const env = new InMemoryEnvService({ TOKEN: "abc" });
		expect(await env.getSecret("TOKEN")).toBe("abc");
	});

	it("returns undefined for missing secrets", async () => {
		const env = new InMemoryEnvService({});
		expect(await env.getSecret("X")).toBeUndefined();
	});

	it("listSecretNames enumerates every key", async () => {
		const env = new InMemoryEnvService({ A: "1", B: "2" });
		expect(Array.from(await env.listSecretNames()).sort()).toEqual(["A", "B"]);
	});

	it("accepts a Map of secrets", async () => {
		const env = new InMemoryEnvService(new Map([["K", "v"]]));
		expect(await env.getSecret("K")).toBe("v");
	});
});
