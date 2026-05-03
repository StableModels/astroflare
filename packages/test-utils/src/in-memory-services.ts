/**
 * Default in-process implementations of the Phase 15b RPC services.
 *
 * `InMemoryFsService` — wraps a `MemorySite` so `write` / `read` /
 * `remove` go through the existing in-memory store. Suitable for
 * tests that exercise the agent-write → HMR loop without a real
 * external agent.
 *
 * `InMemoryLogService` — buffers events in an array; tests assert
 * against the captured calls.
 *
 * `InMemoryEnvService` — reads from a frozen secret map at
 * construction time. Production hosts swap this for the
 * Cloudflare-bound `EnvService` that pulls from `env`-typed
 * Worker bindings.
 */

import type { EnvService, FsService, FsStat, LogService } from "@astroflare/core";
import { sha256Hex } from "@astroflare/core";
import type { MemorySite } from "./memory-site.js";

export class InMemoryFsService implements FsService {
	#site: MemorySite;
	#onWrite?: (path: string, hash: string) => Promise<void> | void;
	#onRemove?: (path: string) => Promise<void> | void;

	constructor(opts: {
		site: MemorySite;
		onWrite?: (path: string, hash: string) => Promise<void> | void;
		onRemove?: (path: string) => Promise<void> | void;
	}) {
		this.#site = opts.site;
		this.#onWrite = opts.onWrite;
		this.#onRemove = opts.onRemove;
	}

	async write(path: string, bytes: Uint8Array): Promise<void> {
		this.#site.write(path, bytes);
		const hash = await sha256Hex(bytes);
		await this.#onWrite?.(path, hash);
	}

	async read(path: string): Promise<Uint8Array | null> {
		return this.#site.readFile(path);
	}

	async remove(path: string): Promise<void> {
		this.#site.remove(path);
		await this.#onRemove?.(path);
	}

	async stat(path: string): Promise<FsStat | null> {
		const s = await this.#site.statFile(path);
		if (!s) return null;
		return { size: s.size, hash: s.hash };
	}
}

export interface CapturedLogEvent {
	name: string;
	fields: Record<string, unknown>;
	at: number;
}

export class InMemoryLogService implements LogService {
	readonly events: CapturedLogEvent[] = [];
	#now: () => number;

	constructor(opts: { now?: () => number } = {}) {
		this.#now = opts.now ?? Date.now;
	}

	async event(name: string, fields: Record<string, unknown>): Promise<void> {
		this.events.push({ name, fields, at: this.#now() });
	}

	clear(): void {
		this.events.length = 0;
	}
}

export class InMemoryEnvService implements EnvService {
	#secrets: ReadonlyMap<string, string>;

	constructor(secrets: Record<string, string> | ReadonlyMap<string, string>) {
		this.#secrets = secrets instanceof Map ? secrets : new Map(Object.entries(secrets));
	}

	async getSecret(name: string): Promise<string | undefined> {
		return this.#secrets.get(name);
	}

	async listSecretNames(): Promise<readonly string[]> {
		return Array.from(this.#secrets.keys());
	}
}
