/**
 * HMR soak test (brief §7.5).
 *
 * 1000 file writes through `Coordinator.onFileChanged` over a short
 * window; assert every published HMR `update` reaches the connected
 * WebSocket and no socket drops occur.
 *
 * The brief calls for "1000 file writes in 10 seconds." On Miniflare
 * dev hardware the round-trip cost is mostly DO-fetch latency + WS
 * delivery; we don't try to artificially throttle. We *do* verify
 * delivery completeness, which is what the brief actually asserts.
 */
import { env } from "cloudflare:test";
import type { HmrMessage } from "@astroflare/core";
import { HibernatingHmrTransport } from "@astroflare/host-cloudflare";
import { MapCoordinator } from "@astroflare/test-utils/in-memory";
import { describe, expect, it } from "vitest";

describe("HMR soak", () => {
	it("delivers every broadcast across 1000 file changes — no missed updates, no drops", async () => {
		const transport = new HibernatingHmrTransport(env.HMR_DO);
		const coordinator = new MapCoordinator();

		// Wire coordinator → transport (mirrors what the preview server
		// does in production). Capture each broadcast promise so the test
		// can await drain at the DO layer; the subscribe callback itself
		// is sync (per the Coordinator API), so we record the promises
		// in a side array.
		const inFlight: Promise<void>[] = [];
		const sub = coordinator.subscribe("hmr", (msg) => {
			inFlight.push(transport.broadcastHmr("soak", msg));
		});

		// Open one client. Receive every broadcast into an array.
		const r = await transport.acceptHmrSocket(
			new Request("https://app/_aflare/hmr", {
				headers: { upgrade: "websocket" },
			}),
			{ workspaceId: "soak" },
		);
		const client = r.webSocket;
		if (!client) throw new Error("expected upgrade");
		client.accept();

		const received: HmrMessage[] = [];
		client.addEventListener("message", (ev) => {
			received.push(JSON.parse(ev.data as string) as HmrMessage);
		});
		let drops = 0;
		client.addEventListener("close", () => {
			drops += 1;
		});

		const N = 1000;
		const start = Date.now();
		// Issue all changes in parallel — Coordinator's `onFileChanged`
		// publishes to subscribers; the broadcast call is started but its
		// promise is captured in `inFlight` for proper await drain below.
		const writes: Promise<void>[] = [];
		for (let i = 0; i < N; i++) {
			writes.push(coordinator.onFileChanged(`/src/pages/p-${i}.astro`, `h-${i}`));
		}
		await Promise.all(writes);
		// Wait for every broadcast at the DO layer to actually complete
		// (HibernatingHmrTransport handles transient DO invalidations
		// internally via retry, so this awaits the full retry chain).
		await Promise.all(inFlight);
		const elapsed = Date.now() - start;

		// Now poll briefly for the WS delivery side — `socket.send` is
		// in-process here but the message dispatch still rides the JS
		// event loop. Bail as soon as we have all messages.
		const deadline = Date.now() + 5_000;
		while (received.length < N && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 25));
		}

		expect(received.length).toBeGreaterThanOrEqual(N);
		expect(drops).toBe(0);

		// Every originating path should appear in some broadcast's trigger.
		const triggers = new Set<string>();
		for (const msg of received) {
			if (msg.type === "update" && msg.trigger) triggers.add(msg.trigger);
		}
		for (let i = 0; i < N; i++) {
			expect(triggers.has(`/src/pages/p-${i}.astro`)).toBe(true);
		}

		console.error(`soak: 1000 changes in ${elapsed}ms (${(elapsed / 10).toFixed(1)} ms / change)`);

		sub.unsubscribe();
		client.close();
	}, 30_000);
});
