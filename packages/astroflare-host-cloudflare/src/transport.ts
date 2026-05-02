/**
 * `HibernatingHmrTransport` — production-shaped `Transport` backed by a
 * Durable Object using Cloudflare's Hibernatable WebSocket API.
 *
 * Per §9.8 of the brief: use `acceptWebSocket()` (the hibernatable variant),
 * NOT `accept()`. Per-connection state via `serializeAttachment()`. The DO
 * may be evicted from memory mid-connection; on wake the WebSockets are
 * re-attached and we read their attachments to recover state.
 *
 * Layout:
 *   - `HmrDurableObject` — the DO class; holds the connection list. Exported
 *     so the host's wrangler.toml can reference it.
 *   - `HibernatingHmrTransport` — implements `Transport`. Has a binding stub
 *     to the DO; routes `acceptHmrSocket` and `broadcastHmr` to a single
 *     per-workspace DO instance keyed by `workspaceId`.
 *
 * The framework's `Transport.acceptHmrSocket` returns
 * `Response | Promise<Response>`; this implementation returns Promise
 * because the DO round-trip is async. Callers `await` it.
 */

import { DurableObject } from "cloudflare:workers";
import type { HmrMessage, HmrSocketContext, Transport } from "@astroflare/core";

interface ConnectionAttachment {
	workspaceId: string;
	connectedAt: number;
}

const PATH_UPGRADE = "/__upgrade";
const PATH_BROADCAST = "/__broadcast";
const PATH_SIZE = "/__size";

/**
 * The DO class. One instance per workspace (keyed by
 * `idFromName(workspaceId)` by the wrapping `HibernatingHmrTransport`).
 * Holds the WebSocket pool and fans out HMR messages.
 */
export class HmrDurableObject extends DurableObject {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case PATH_UPGRADE: {
				const workspaceId = url.searchParams.get("workspaceId") ?? "default";
				return this.#acceptUpgrade(workspaceId);
			}
			case PATH_BROADCAST: {
				const msg = (await request.json()) as HmrMessage;
				await this.#broadcast(msg);
				return new Response("ok");
			}
			case PATH_SIZE: {
				return new Response(String(this.ctx.getWebSockets().length));
			}
			default:
				return new Response("Not Found", { status: 404 });
		}
	}

	#acceptUpgrade(workspaceId: string): Response {
		const pair = new WebSocketPair();
		// Object.values returns array, indexes give us [client, server].
		const client = pair[0];
		const server = pair[1];
		// `acceptWebSocket` (hibernatable variant) — survives DO eviction.
		this.ctx.acceptWebSocket(server);
		const attachment: ConnectionAttachment = {
			workspaceId,
			connectedAt: Date.now(),
		};
		server.serializeAttachment(attachment);
		return new Response(null, { status: 101, webSocket: client });
	}

	async #broadcast(msg: HmrMessage): Promise<void> {
		const sockets = this.ctx.getWebSockets();
		const payload = JSON.stringify(msg);
		for (const socket of sockets) {
			try {
				socket.send(payload);
			} catch {
				// Socket may have closed mid-iteration; the Hibernation API is
				// resilient — drop quietly.
			}
		}
	}

	// Hibernation lifecycle handlers — workerd calls these when waking the DO.

	override webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void | Promise<void> {
		// Phase 2.5e: client → server messages aren't part of the HMR
		// protocol yet (server pushes only). If a future feature needs
		// them, decode here and route.
	}

	override webSocketClose(
		_ws: WebSocket,
		_code: number,
		_reason: string,
		_wasClean: boolean,
	): void | Promise<void> {
		// Cloudflare auto-removes closed sockets from `getWebSockets()`; no
		// manual bookkeeping needed.
	}

	override webSocketError(_ws: WebSocket, _error: unknown): void | Promise<void> {
		// Same as close — no bookkeeping; workerd handles eviction.
	}
}

/**
 * Framework-facing transport. One instance wraps a `DurableObjectNamespace`
 * binding to `HmrDurableObject`. Routes by `idFromName(workspaceId)`.
 */
export class HibernatingHmrTransport implements Transport {
	readonly #namespace: DurableObjectNamespace<HmrDurableObject>;

	constructor(namespace: DurableObjectNamespace<HmrDurableObject>) {
		this.#namespace = namespace;
	}

	async acceptHmrSocket(_req: Request, ctx: HmrSocketContext): Promise<Response> {
		const stub = this.#stub(ctx.workspaceId);
		return stub.fetch(
			`https://hmr-internal${PATH_UPGRADE}?workspaceId=${encodeURIComponent(ctx.workspaceId)}`,
			{ headers: { upgrade: "websocket" } },
		);
	}

	async broadcastHmr(workspaceId: string, msg: HmrMessage): Promise<void> {
		const stub = this.#stub(workspaceId);
		await stub.fetch(`https://hmr-internal${PATH_BROADCAST}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(msg),
		});
	}

	/** Number of currently-attached sockets (test affordance). */
	async size(workspaceId: string): Promise<number> {
		const stub = this.#stub(workspaceId);
		const r = await stub.fetch(`https://hmr-internal${PATH_SIZE}`);
		return Number.parseInt(await r.text(), 10);
	}

	#stub(workspaceId: string): DurableObjectStub<HmrDurableObject> {
		return this.#namespace.get(this.#namespace.idFromName(workspaceId));
	}
}
