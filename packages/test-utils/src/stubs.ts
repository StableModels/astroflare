/**
 * Trivial stubs for `Clock`, `Logger`, `Transport`.
 *
 * `MemoryTransport` records broadcasts in a queue so tests can assert on them.
 * `acceptHmrSocket` returns a 200 — no real WebSocket; tests of the WS
 * lifecycle live in Layer B (workerd) where `WebSocketPair` is available.
 */
import type { Clock, HmrMessage, HmrSocketContext, Logger, Transport } from "@astroflare/core";

export class StubClock implements Clock {
	#t: number;
	constructor(start = 0) {
		this.#t = start;
	}
	now(): number {
		return this.#t;
	}
	advance(ms: number): void {
		this.#t += ms;
	}
	set(t: number): void {
		this.#t = t;
	}
}

export interface RecordedEvent {
	name: string;
	fields: Record<string, unknown>;
	at: number;
}

export class StubLogger implements Logger {
	readonly events: RecordedEvent[] = [];
	#clock: Clock;

	constructor(clock: Clock = new StubClock()) {
		this.#clock = clock;
	}

	event(name: string, fields: Record<string, unknown>): void {
		this.events.push({ name, fields, at: this.#clock.now() });
	}

	/** Filter recorded events by name. */
	byName(name: string): RecordedEvent[] {
		return this.events.filter((e) => e.name === name);
	}
}

export interface RecordedBroadcast {
	workspaceId: string;
	msg: HmrMessage;
}

export class MemoryTransport implements Transport {
	readonly broadcasts: RecordedBroadcast[] = [];
	readonly accepted: HmrSocketContext[] = [];

	acceptHmrSocket(_req: Request, ctx: HmrSocketContext): Response {
		this.accepted.push(ctx);
		return new Response(null, { status: 200 });
	}

	async broadcastHmr(workspaceId: string, msg: HmrMessage): Promise<void> {
		this.broadcasts.push({ workspaceId, msg });
	}
}
