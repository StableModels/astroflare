/**
 * `SqlCache` — content-addressed compile cache backed by Durable Object
 * sqlite (Phase 26). Stored under the `aflare_cache` table prefix in
 * whatever sqlite the host hands over (typically `ctx.storage.sql` from
 * inside a SiteDurableObject).
 *
 * Used by Mode A (preview) to skip recompiling unchanged source. Bytes are
 * stored inline as BLOB; for the typical compile-cache entry size (a few KB
 * of compiled JS) this is the right shape.
 *
 * Size-cap caveat: `SqlCache` inherits Cloudflare DO SQLite's hard
 * per-row/BLOB limit of 2 MB. A host that can emit large compiled modules
 * (e.g. a page that bakes fetched data into static consts, compiling to a
 * >2 MB module) will make `put()` throw `SQLITE_TOOBIG`. The framework
 * treats a throwing Cache as semantically identical to an empty one — the
 * `ModuleGraph` warm path swallows get/put failures and degrades to
 * "recompile uncached" (never escaping into the DO storage layer), so an
 * oversized entry is slow, not fatal. Hosts that routinely emit large
 * modules should supply an overflow-capable `Cache` (e.g. an R2-backed
 * impl, ~5 TiB object cap) instead of `SqlCache`.
 */

import type { Cache } from "@astroflare/core";

/**
 * Subset of `SqlStorage` (DO sqlite) that we use. Letting the host pass in
 * any `SqlStorage`-shaped object keeps tests untangled from `cloudflare:workers`.
 */
export interface SqlBackend {
	exec<T = unknown>(query: string, ...bindings: unknown[]): SqlExecResult<T>;
}

export interface SqlExecResult<T> {
	toArray(): T[];
	[Symbol.iterator](): IterableIterator<T>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS aflare_cache (
	hash TEXT PRIMARY KEY,
	bytes BLOB NOT NULL,
	created_at INTEGER NOT NULL
);
`;

export class SqlCache implements Cache {
	readonly #sql: SqlBackend;
	#initialized = false;

	constructor(sql: SqlBackend) {
		this.#sql = sql;
	}

	#ensure(): void {
		if (this.#initialized) return;
		this.#sql.exec(SCHEMA);
		this.#initialized = true;
	}

	async get(hash: string): Promise<Uint8Array | null> {
		this.#ensure();
		const rows = this.#sql
			.exec<{ bytes: ArrayBuffer | Uint8Array }>(
				"SELECT bytes FROM aflare_cache WHERE hash = ?",
				hash,
			)
			.toArray();
		const first = rows[0];
		if (!first) return null;
		const value = first.bytes;
		return value instanceof Uint8Array ? value : new Uint8Array(value);
	}

	async put(hash: string, bytes: Uint8Array): Promise<void> {
		this.#ensure();
		// SQLite's INSERT OR IGNORE keeps the put idempotent — same hash, same
		// bytes by content addressing, so collisions are no-ops.
		const copy = new Uint8Array(bytes.byteLength);
		copy.set(bytes);
		this.#sql.exec(
			"INSERT OR IGNORE INTO aflare_cache (hash, bytes, created_at) VALUES (?, ?, ?)",
			hash,
			copy,
			Date.now(),
		);
	}
}
