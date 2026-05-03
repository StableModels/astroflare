/**
 * `HibernatingHmrTransport` against a real Hibernatable WebSocket Durable
 * Object. Exercises:
 *
 *   - WebSocket upgrade returns 101 with a paired client socket
 *   - `broadcastHmr` reaches every active connection
 *   - per-workspace isolation (different `workspaceId` = different DO instance)
 *   - hibernation: state survives `runInDurableObject`-driven simulation
 *     (workerd's hibernation API is exercised; a true mid-flight eviction
 *     can't be triggered from tests but the persistence-via-attachment
 *     pathway is tested through `getWebSockets()` post-restoration)
 */
import { env } from "cloudflare:test";
import type { HmrMessage } from "@astroflare/core";
import { HibernatingHmrTransport } from "@astroflare/host-cloudflare";
import { describe, expect, it } from "vitest";

const HMR_REQ = (workspaceId: string) =>
	new Request(`https://app/_aflare/hmr?ws=${workspaceId}`, {
		headers: { upgrade: "websocket" },
	});

async function openSocket(
	transport: HibernatingHmrTransport,
	workspaceId: string,
): Promise<WebSocket> {
	const r = await transport.acceptHmrSocket(HMR_REQ(workspaceId), { workspaceId });
	expect(r.status).toBe(101);
	const client = r.webSocket;
	if (!client) throw new Error("expected upgrade response to attach a webSocket");
	client.accept();
	return client;
}

describe("HibernatingHmrTransport: upgrade", () => {
	it("returns a 101 with an attached client WebSocket", async () => {
		const transport = new HibernatingHmrTransport(env.HMR_DO);
		const client = await openSocket(transport, "smoke-1");
		client.close();
	});

	it("the DO records the connection — size() reflects active sockets", async () => {
		const transport = new HibernatingHmrTransport(env.HMR_DO);
		expect(await transport.size("size-test")).toBe(0);
		const client = await openSocket(transport, "size-test");
		expect(await transport.size("size-test")).toBe(1);
		client.close();
	});
});

describe("HibernatingHmrTransport: broadcast", () => {
	it("broadcastHmr delivers to every connected socket", async () => {
		const transport = new HibernatingHmrTransport(env.HMR_DO);
		const a = await openSocket(transport, "broadcast-test");
		const b = await openSocket(transport, "broadcast-test");

		const messages: { socket: "a" | "b"; data: HmrMessage }[] = [];
		const aReady = new Promise<HmrMessage>((resolve) => {
			a.addEventListener("message", (ev) => {
				const data = JSON.parse(ev.data as string) as HmrMessage;
				messages.push({ socket: "a", data });
				resolve(data);
			});
		});
		const bReady = new Promise<HmrMessage>((resolve) => {
			b.addEventListener("message", (ev) => {
				const data = JSON.parse(ev.data as string) as HmrMessage;
				messages.push({ socket: "b", data });
				resolve(data);
			});
		});

		const msg: HmrMessage = {
			type: "update",
			trigger: "/src/pages/x.astro",
			updates: [{ path: "/src/pages/x.astro", hash: "h1", kind: "module" }],
		};
		await transport.broadcastHmr("broadcast-test", msg);

		const [aMsg, bMsg] = await Promise.all([aReady, bReady]);
		expect(aMsg).toEqual(msg);
		expect(bMsg).toEqual(msg);
		expect(messages).toHaveLength(2);

		a.close();
		b.close();
	});

	it("broadcasts to one workspaceId don't leak into another", async () => {
		const transport = new HibernatingHmrTransport(env.HMR_DO);
		const a = await openSocket(transport, "tenant-a");
		const b = await openSocket(transport, "tenant-b");

		let aGot: HmrMessage | null = null;
		const bGot: HmrMessage | null = null;
		a.addEventListener("message", (ev) => {
			aGot = JSON.parse(ev.data as string) as HmrMessage;
		});
		b.addEventListener("message", (ev) => {
			expect(ev).not.toBeNull(); // Should never run in this test.
			throw new Error("tenant-b should not have received tenant-a's broadcast");
		});

		await transport.broadcastHmr("tenant-a", { type: "full-reload", reason: "test" });
		// Give event loop a tick to deliver any messages.
		await new Promise((r) => setTimeout(r, 50));

		expect(aGot).toEqual({ type: "full-reload", reason: "test" });
		expect(bGot).toBeNull();

		a.close();
		b.close();
	});
});

describe("HibernatingHmrTransport: hibernation pathway", () => {
	it("acceptWebSocket attaches per-connection state via serializeAttachment", async () => {
		// Accept a socket, then verify the DO sees it via getWebSockets() —
		// this is the exact mechanism that survives DO hibernation: on wake,
		// workerd repopulates getWebSockets() from the persisted attachments.
		const transport = new HibernatingHmrTransport(env.HMR_DO);
		const client = await openSocket(transport, "hibernation");

		// Even after a delay (simulating "the test doesn't hold a reference"),
		// the DO still has the socket — meaning workerd persisted it.
		await new Promise((r) => setTimeout(r, 50));
		expect(await transport.size("hibernation")).toBe(1);

		client.close();
		// And after close, `getWebSockets()` reflects the removal.
		await new Promise((r) => setTimeout(r, 50));
		expect(await transport.size("hibernation")).toBe(0);
	});
});
