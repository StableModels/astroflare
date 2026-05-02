import { describe, expect, it, vi } from "vitest";
import { ASTROFLARE_VERSION, type Host, createApp, defineConfig } from "./index.js";

const noopHost = (overrides: Partial<Host> = {}): Host => ({
	storage: {
		read: vi.fn(),
		write: vi.fn(),
		remove: vi.fn(),
		glob: vi.fn(),
		stat: vi.fn(),
		cacheRead: vi.fn(),
		cacheWrite: vi.fn(),
	} as unknown as Host["storage"],
	executor: {
		runOnce: vi.fn(),
		runCached: vi.fn(),
	},
	coordinator: {
		onFileChanged: vi.fn(async () => undefined),
		graphGet: vi.fn(async () => null),
		graphPut: vi.fn(async () => undefined),
		graphRemove: vi.fn(async () => undefined),
		publish: vi.fn(async () => undefined),
		subscribe: vi.fn(() => ({ unsubscribe() {} })),
	},
	transport: {
		// Node's Response disallows 101 in the constructor; in workerd 101 is valid
		// for WebSocket upgrades. The test only verifies forwarding, so use 200 here.
		acceptHmrSocket: vi.fn(() => new Response(null, { status: 200 })),
		broadcastHmr: vi.fn(async () => undefined),
	},
	clock: { now: () => 0 },
	logger: { event: vi.fn() },
	...overrides,
});

describe("@astroflare/core", () => {
	it("exports a version constant", () => {
		expect(ASTROFLARE_VERSION).toBe("0.0.0");
	});

	it("defineConfig is identity at runtime", () => {
		const cfg = defineConfig({ site: "https://example.com" });
		expect(cfg.site).toBe("https://example.com");
	});

	it("createApp logs creation and forwards file-change to coordinator", async () => {
		const host = noopHost();
		const app = createApp({ site: "https://example.com" }, host);
		expect(host.logger.event).toHaveBeenCalledWith(
			"app.created",
			expect.objectContaining({ site: "https://example.com" }),
		);
		await app.notifyFileChanged("/src/pages/index.astro", "abc123");
		expect(host.coordinator.onFileChanged).toHaveBeenCalledWith("/src/pages/index.astro", "abc123");
	});

	it("createApp forwards HMR upgrade to the transport", () => {
		const host = noopHost();
		const app = createApp({}, host);
		const req = new Request("https://example.com/_aflare/hmr", {
			headers: { upgrade: "websocket" },
		});
		const res = app.handleHmrUpgrade(req);
		expect(host.transport.acceptHmrSocket).toHaveBeenCalledWith(
			req,
			expect.objectContaining({ workspaceId: "default" }),
		);
		expect(res.status).toBe(200);
	});
});
